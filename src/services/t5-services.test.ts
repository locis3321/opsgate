/**
 * T5 服务层单元测试：crypto（AES-256-GCM/AAD/指纹）/ guardRules（block 先于 mark、priority）/
 * transfer（单次使用、超限、sha256/size 不符、TTL）/ audit（write-ahead 落库、脱敏）。
 */
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptCredential,
  encryptCredential,
  credentialFingerprint,
  loadCredentialKey,
} from './crypto.js';
import { evaluateRules, loadActiveRules } from './guardRules.js';
import {
  TransferService,
  TransferTokenError,
  TransferSizeMismatchError,
  TransferLimitError,
  sha256Of,
} from './transfer.js';
import { AuditService, redactValue } from './audit.js';

const MIGRATIONS = fileURLToPath(new URL('../db/migrations', import.meta.url));
const openDbs: Database.Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function memDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  openDbs.push(db);
  return db;
}

describe('crypto（§5.6 AES-256-GCM，AAD=credentialId）', () => {
  it('加解密 roundtrip + 格式 v1.<iv>.<tag>.<cipher>', () => {
    const key = loadCredentialKey(path.join(tmpdir(), `opsgate-k-${Date.now()}`));
    try {
      const ct = encryptCredential(key, 'cred-1', '{"user":"root"}');
      expect(ct.startsWith('v1.')).toBe(true);
      expect(ct.split('.')).toHaveLength(4);
      expect(decryptCredential(key, 'cred-1', ct)).toBe('{"user":"root"}');
      // AAD 绑定：不同 credentialId 解密失败
      expect(() => decryptCredential(key, 'cred-2', ct)).toThrow();
    } finally {
      // 临时密钥文件由 loadCredentialKey 写入 tmp；不清理（tmp 目录）
    }
  });

  it('指纹随 credentialId/updatedAt 稳定变化', () => {
    const a = credentialFingerprint('cred-1', 1000);
    expect(a).toBe(credentialFingerprint('cred-1', 1000));
    expect(a).not.toBe(credentialFingerprint('cred-1', 2000));
  });
});

describe('guardRules（§5.8 先 block 后 mark，priority 最高者胜）', () => {
  const rules = [
    { id: 'g1', name: 'RCE', kind: 'block' as const, target: 'arg' as const, pattern: '; *rm *-rf', priority: 800 },
    { id: 'g2', name: '高危命令', kind: 'mark' as const, target: 'arg' as const, pattern: 'rm *-rf', priority: 400 },
    { id: 'g3', name: '写删工具', kind: 'mark' as const, target: 'tool' as const, pattern: '(execute|delete)$', priority: 600 },
  ];
  it('RCE 特征命中 block（先于 mark，AC-18 语义）', () => {
    const hit = evaluateRules(rules, { tool: 'native:host.execute_command', args: { command: 'x; rm -rf /' }, assetType: 'host' });
    expect(hit?.kind).toBe('block');
    expect(hit?.ruleId).toBe('g1');
  });
  it('高危命令命中 mark（返回 risk 数据源）', () => {
    const mark = evaluateRules(rules, { tool: 'derived:svr:host_exec', args: { command: 'sudo rm -rf /tmp/x' }, assetType: 'host' });
    expect(mark?.kind).toBe('mark');
    expect(mark?.ruleId).toBe('g2');
  });
  it('工具名 mark 规则命中；无命中返回 null', () => {
    expect(evaluateRules(rules, { tool: 'derived:svr:host_execute', args: {}, assetType: 'host' })?.ruleId).toBe('g3');
    expect(evaluateRules(rules, { tool: 'native:host.echo', args: { a: '1' }, assetType: 'host' })).toBeNull();
  });
  it('loadActiveRules 从 DB 读取 enabled+priority 排序', () => {
    const db = memDb();
    // 与 0014 迁移后的真实列一致（scope/scope_value/source 是 2026-11-18 三级作用域）
    db.exec(`CREATE TABLE guard_rules (
      id text PRIMARY KEY, name text NOT NULL, kind text NOT NULL, target text NOT NULL,
      pattern text NOT NULL, enabled integer NOT NULL DEFAULT 1, priority integer NOT NULL DEFAULT 0,
      locked integer NOT NULL DEFAULT 0, builtin integer NOT NULL DEFAULT 0, hit_count integer NOT NULL DEFAULT 0,
      last_hit_at integer, description text,
      scope text NOT NULL DEFAULT 'global', scope_value text, owner_id text, source text NOT NULL DEFAULT 'builtin')`);
    db.exec(`INSERT INTO guard_rules (id, name, kind, target, pattern, enabled, priority) VALUES
      ('r1','x','block','arg','rm -rf', 0, 900),
      ('r2','y','mark','tool','(delete)$', 1, 100),
      ('r3','z','block','arg','rm -rf', 1, 500)`);
    const loaded = loadActiveRules(db);
    expect(loaded.map((r) => r.id)).toEqual(['r3', 'r2']);
    // 未显式写 scope 的行按 global 生效（迁移后的默认值）
    expect(loaded.every((r) => r.scope === 'global')).toBe(true);
  });
});

describe('transfer（§5.5.7 一次性入口）', () => {
  let dir: string;
  let svc: TransferService;
  beforeEach(() => {
    dir = path.join(tmpdir(), `opsgate-tf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    svc = new TransferService({
      dataDir: dir,
      maxFileBytes: 10_000_000,
      entryTtlMs: 60_000,
      stagingQuotaBytes: 2_000_000_000,
      stagingTtlMs: 900_000,
    });
  });

  it('AC-43 单次使用：第二次 consume 抛 TransferTokenError', () => {
    const e = svc.createUpload({ userId: 'u-1', assetId: 'a-1', remotePath: '/tmp/x', declaredSize: 10 });
    const first = svc.consume(e.token, 'upload');
    expect(first.id).toBe(e.id);
    expect(() => svc.consume(e.token, 'upload')).toThrow(TransferTokenError);
  });

  it('AC-42 实际字节超声明 → fail 且暂存删除', () => {
    const e = svc.createUpload({ userId: 'u-1', assetId: 'a-1', remotePath: '/tmp/x', declaredSize: 5 });
    const body = Buffer.from('1234567890');
    expect(() => svc.receive(e.id, body)).toThrow(TransferSizeMismatchError);
    expect(svc.get(e.id)?.status).toBe('failed');
    expect(existsSync(svc.stagingFileOf(svc.get(e.id)!))).toBe(false);
  });

  it('AC-42/44 sha256 不符 → fail', () => {
    const e = svc.createUpload({ userId: 'u-1', assetId: 'a-1', remotePath: '/tmp/x', declaredSize: 100, declaredSha256: 'deadbeef' });
    expect(() => svc.receive(e.id, Buffer.from('abc'))).toThrow(TransferSizeMismatchError);
    expect(svc.get(e.id)?.status).toBe('failed');
  });

  it('AC-42 超限：申请 size > 上限 → TransferLimitError 且入口不发放', () => {
    expect(() => svc.createUpload({ userId: 'u', assetId: 'a', remotePath: '/x', declaredSize: 100_000_001 })).toThrow(TransferLimitError);
  });

  it('TTL 过期后 consume 失败；sweep 清理', () => {
    const stale = new TransferService({
      dataDir: dir,
      maxFileBytes: 1000,
      entryTtlMs: -1,
      stagingQuotaBytes: 1000,
      stagingTtlMs: 1,
    });
    const e = stale.createUpload({ userId: 'u', assetId: 'a', remotePath: '/x', declaredSize: 1 });
    expect(() => stale.consume(e.token, 'upload')).toThrow(TransferTokenError);
    expect(stale.sweep()).toBeGreaterThanOrEqual(1);
  });

  it('sha256Of 正确', () => {
    expect(sha256Of(Buffer.from('abc'))).toHaveLength(64);
  });

  it('ADR-024 热生效：entry_ttl_sec / staging_quota_bytes / max_file_bytes 逐次读取', () => {
    const hotDir = path.join(tmpdir(), `opsgate-tf-hot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(hotDir, { recursive: true });
    const vals: Record<string, number> = {
      'transfer.max_file_bytes': 1000,
      'transfer.entry_ttl_sec': 60,
      'transfer.staging_quota_bytes': 1000,
      'transfer.staging_ttl_sec': 900,
    };
    const src = { get: <T>(key: string): T => vals[key] as T };
    const hot = new TransferService({ dataDir: hotDir, maxFileBytes: 1, entryTtlMs: 1, stagingQuotaBytes: 1, stagingTtlMs: 1 }, src);

    // entry_ttl_sec=60：入口有效期约 60s（构造快照是 1s，若未热读这里会立刻过期）
    const e = hot.createUpload({ userId: 'u', assetId: 'a', remotePath: '/x', declaredSize: 10 });
    expect(e.expiresAt - e.createdAt).toBeGreaterThanOrEqual(59_000);
    expect(() => hot.consume(e.token, 'upload')).not.toThrow();

    // max_file_bytes 热读：改小后立即拒绝（下载同样走热读）
    vals['transfer.max_file_bytes'] = 5;
    const small = (n: number) => ({ userId: 'u', assetId: 'a', remotePath: '/y', size: n, sha256: sha256Of(Buffer.alloc(n)), data: Buffer.alloc(n) });
    expect(() => hot.createDownload(small(6))).toThrow(TransferLimitError);

    // staging_quota_bytes 热读：已落 600 字节，再申请 500 → 1100 > 1000 拒绝；300 → 900 放行
    vals['transfer.max_file_bytes'] = 10_000;
    hot.createDownload(small(600));
    expect(hot.stagingUsage().bytes).toBe(600);
    expect(() => hot.createDownload(small(500))).toThrow(TransferLimitError);
    expect(() => hot.createDownload(small(300))).not.toThrow();
  });
});

describe('audit（write-ahead + 脱敏）', () => {
  it('intent → fill 可检索；红键脱敏与凭证值等值掩码', async () => {
    const db = memDb();
    await migrate(drizzle(db), { migrationsFolder: MIGRATIONS });
    const svc = new AuditService(db);
    const { intentId } = await svc.writeIntent({
      principal: { userId: 'u-1', isAdmin: true },
      asset: { id: 'a-1', name: 'web-01' },
      tool: 'native:host.execute_command',
      args: { command: 'echo hi', password: 'sekret' },
      risk: 'high',
      status: 'pending',
    });
    await svc.fill({ intentId, status: 'success', outputSummary: '{"exitCode":0}', durationMs: 12 });
    const _m = String(new Date().getMonth() + 1).padStart(2, '0');
    const _y = new Date().getFullYear();
    const row = db.prepare(`SELECT tool, input_summary, status, output_summary FROM audit_log_${_y}_${_m} WHERE id = ?`).get(intentId) as Record<string, string>;
    expect(row.tool).toBe('native:host.execute_command');
    expect(row.input_summary).toContain('***');
    expect(row.input_summary).not.toContain('sekret');
    expect(row.status).toBe('success');
    expect(row.output_summary).toContain('exitCode');
  });

  it('redactValue：key 命中 → ***；与凭证值相等 → ***credential***', () => {
    const out = redactValue({ password: 'x', ok: 'y', nested: { secret: 's' } }, ['y']) as Record<string, unknown>;
    expect(out).toMatchObject({ password: '***', nested: { secret: '***' } });
    expect(out.ok).toBe('***credential***');
  });
});
