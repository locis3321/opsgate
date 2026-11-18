/**
 * T5 集成测试（真实 SSH）：需要 Docker sshd 容器（test/docker/sshd）监听 127.0.0.1:2222。
 * 运行：SSH_E2E=1 pnpm exec vitest run src/native/ssh.integration.test.ts
 * 覆盖 T5 验收：命令执行/输出截断/无子进程/无 PTY/上传三步+原子落位/文件不进 MCP/一次性 token/
 * 超限/敏感路径(block)/指纹未信任拒绝/下载+单次 GET/审计三事件。
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AssetView } from '../framework/types.js';
import * as schema from '../db/schema.js';
import { Settings } from '../config/settings.js';
import { loadCredentialKey, encryptCredential } from '../services/crypto.js';
import { AuditService } from '../services/audit.js';
import { CredentialService } from '../services/credentials.js';
import { TransferService } from '../services/transfer.js';
import { setTransferService } from '../services/transferInstance.js';
import { SshConnector } from './connectors/ssh.js';
import { registerConnector } from './connectors/index.js';
import { makeNativeDispatchServices } from '../services/nativeDispatch.js';
import { dispatchNativeTool } from '../framework/dispatch.js';
import { loadNativeTools } from '../native/tools/index.js';
import { createAuth, ensureAuthTables } from '../services/auth.js';
import { buildApp } from '../app.js';
import { Client } from 'ssh2';

const MIGRATIONS = fileURLToPath(new URL('../db/migrations', import.meta.url));

const HOST = '127.0.0.1';
const PORT = 2222;
const USER = 'ops';
const PASS = 'ops-pass-123';
const BASE_URL = 'http://127.0.0.1:8080';

const run = process.env.SSH_E2E === '1';

interface Ctx {
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
  settings: Settings;
  audit: AuditService;
  transfer: TransferService;
  ssh: SshConnector;
  tools: Awaited<ReturnType<typeof loadNativeTools>>;
  dispatch: ReturnType<typeof makeNativeDispatchServices>;
  app: FastifyInstance;
  assetId: string;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!run) return;
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const settings = new Settings({ getAll: async () => [] });
  await settings.init();
  const key = loadCredentialKey(path.join(mkdtempSync(path.join(tmpdir(), 'opsgate-key-')), 'credentials.key'));
  const audit = new AuditService(sqlite);
  const credentials = new CredentialService(sqlite, key);
  const transfer = new TransferService({
    dataDir: mkdtempSync(path.join(tmpdir(), 'opsgate-tf-')),
    maxFileBytes: 209715200,
    entryTtlMs: 300000,
    stagingQuotaBytes: 2147483648,
    stagingTtlMs: 900000,
  });
  setTransferService(transfer);

  // 数据：owner 用户 + 凭证（密码）+ 资产（未信任指纹）
  const user = await db
    .insert(schema.users)
    .values({ id: 'u-owner', username: 'owner', name: 'owner' })
    .returning({ id: schema.users.id })
    .get()!;
  const credId = 'cred-ssh-1';
  await db
    .insert(schema.credentials)
    .values({
      id: credId,
      name: 'ops-ssh',
      encryptedValues: encryptCredential(key, credId, JSON.stringify({ AUTH: PASS })),
      valueHint: '****123',
      ownerId: user.id,
    })
    .run();
  await db
    .insert(schema.servers)
    .values({
      id: 'srv-1',
      name: 'web-01',
      type: 'native',
      executionMode: 'native',
      category: 'host',
      hostConn: { host: HOST, port: PORT, username: USER, authSlot: 'AUTH', hostFingerprint: null },
      ownerId: user.id,
      configHash: 'cfg-1',
    })
    .run();
  await db
    .insert(schema.serverCredentials)
    .values({ serverId: 'srv-1', slotName: 'AUTH', userId: user.id, credentialId: credId, scope: 'asset' })
    .run();
  // 内置规则（敏感路径 block + RCE block）
  await db
    .insert(schema.guardRules)
    .values([
      {
        id: 'gr-block-sens-upload',
        name: '敏感路径上传',
        kind: 'block',
        target: 'arg',
        pattern: '^/etc/|^/root/\\.ssh/|^/var/spool/cron/|crontab$|\\.bashrc$|\\.profile$|\\.zshrc$|\\.bash_profile$',
        enabled: true,
        locked: true,
        builtin: true,
        priority: 700,
        hitCount: 0,
      },
      {
        id: 'gr-block-rce',
        name: '命令注入 RCE 特征',
        kind: 'block',
        target: 'arg',
        pattern: ';\\s*rm\\s+-rf|\\|\\s*sh\\b',
        enabled: true,
        locked: true,
        builtin: true,
        priority: 800,
        hitCount: 0,
      },
    ])
    .run();

  const ssh = new SshConnector({
    idleTtlMs: 60_000,
    semaphore: 8,
    queueTimeoutMs: 15_000,
    truncateBytes: 4096,
    resolveCredential: async (asset: AssetView) => {
      const slot = asset.hostConn?.authSlot;
      if (!slot) throw new Error('no authSlot');
      const res = credentials.resolveSlotValues(asset.id, [slot]);
      if (res.length === 0) throw new Error('no cred');
      return { credentialId: res[0]!.credentialId, updatedAtMs: res[0]!.updatedAtMs, password: res[0]!.value };
    },
    expectFingerprint: (asset: AssetView) => asset.hostConn?.hostFingerprint ?? null,
  });
  registerConnector(ssh);

  const dispatch = makeNativeDispatchServices({ sqlite, db, settings, audit, credentials });
  const tools = await loadNativeTools();

  const auth = createAuth(sqlite, { secret: 'test-secret-0123456789abcdef0123456789', baseUrl: BASE_URL });
  await ensureAuthTables(auth);
  const app = await buildApp({
    db,
    auth,
    baseUrl: BASE_URL,
    transfer,
    ssh,
    credentials,
    audit,
    verifyTransferToken: async (token, _p, method) => {
      try {
        const dir = method.toUpperCase() === 'PUT' ? 'upload' : 'download';
        const e = transfer.consume(token, dir);
        return { userId: e.userId, isAdmin: false };
      } catch {
        return null;
      }
    },
  });

  ctx = { sqlite, db, settings, audit, transfer, ssh, tools, dispatch, app, assetId: 'srv-1' };
}, 60_000);

afterAll(async () => {
  if (!run) return;
  await ctx.app.close();
  ctx.sqlite.close();
});

async function trustFingerprint(): Promise<string> {
  // 与 routes/servers.ts 同构：raw ssh2 捕获主机公钥
  return await new Promise<string>((resolve, reject) => {
    let hostKey: Buffer | null = null;
    const c = new Client();
    c.once('ready', () => {
      c.end();
      resolve(fpOf(hostKey!));
    });
    c.once('error', reject);
    c.connect({
      host: HOST,
      port: PORT,
      username: USER,
      password: PASS,
      readyTimeout: 10_000,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        hostKey = key;
        verify(true); // 信任采集：接受并捕获公钥 wire blob
      },
    });
  });
}

function fpOf(key: Buffer): string {
  const b64 = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${b64}`;
}

async function trust(): Promise<void> {
  const fp = await trustFingerprint();
  const row = (await ctx.db.select().from(schema.servers).where(eq(schema.servers.id, 'srv-1')).get())!;
  await ctx.db.update(schema.servers).set({ hostConn: { ...(row.hostConn as object), hostFingerprint: fp } }).where(eq(schema.servers.id, 'srv-1')).run();
}

const PRINCIPAL = { userId: 'u-owner', isAdmin: false };

function tool(id: string) {
  const t = ctx.tools.find((x) => x.id === id);
  if (!t) throw new Error(`tool not found: ${id}`);
  return t;
}

function childProcessCount(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (process as any)._getActiveHandles().filter((h: { constructor?: { name?: string } }) => h.constructor?.name === 'ChildProcess').length;
}

describe.runIf(run)('T5 原生 SSH 集成（Docker sshd）', () => {
  it('AC-47 指纹未信任 → 连接被拒绝（不做自动信任）', async () => {
    const before = await childProcessCount();
    const out = await dispatchNativeTool(tool('host.execute_command'), { asset: 'web-01', command: 'echo hi' }, PRINCIPAL, ctx.dispatch);
    expect(out.ok).toBe(false);
    expect(out.code).toBe(-32002);
    expect(out.message ?? '').toContain('主机指纹'); // E2E R3 FAIL 复验：拒绝正确 + 中文指引
    expect(await childProcessCount()).toBe(before); // 不产生子进程（AC-37）
  });

  it('信任指纹后：命令执行成功 + 无子进程 + 审计到人五要素', async () => {
    await trust();
    const before = await childProcessCount();
    const out = await dispatchNativeTool(tool('host.execute_command'), { asset: 'web-01', command: 'echo hello-from-ssh' }, PRINCIPAL, ctx.dispatch);
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({ content: { stdout: 'hello-from-ssh\n', exit_code: 0 } });
    expect(await childProcessCount()).toBe(before); // AC-37：不产生任何子进程
    const row = ctx.sqlite.prepare("SELECT tool, status, user_id, server_id, credential_id, duration_ms FROM audit_log_2026_10 ORDER BY ts DESC LIMIT 1").get() as Record<string, string>;
    expect(row.tool).toBe('native:host.execute_command');
    expect(row.status).toBe('success');
    expect(row.user_id).toBe('u-owner');
    expect(row.server_id).toBe('srv-1');
    expect(row.credential_id).toBe('cred-ssh-1'); // AC-12 五要素之"用哪个账号"
    expect(row.duration_ms).not.toBeNull(); // F-R6-3：调用方必须回填时长（dispatch.ts 修复回归）
    expect(Number(row.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it('AC-39 输出截断：>4KB 置 truncated=true', async () => {
    const out = await dispatchNativeTool(
      tool('host.execute_command'),
      { asset: 'web-01', command: 'for i in $(seq 1 2000); do echo "line-$i"; done' },
      PRINCIPAL,
      ctx.dispatch,
    );
    expect(out.ok).toBe(true);
    const content = (out.data as { content: { stdout: string; truncated: { stdout: boolean } } }).content;
    expect(content.stdout.length).toBeLessThanOrEqual(4097);
    expect(content.truncated.stdout).toBe(true);
  });

  it('无 PTY：tty 命令返回非 0 而非挂起', async () => {
    const out = await dispatchNativeTool(tool('host.execute_command'), { asset: 'web-01', command: 'tty' }, PRINCIPAL, ctx.dispatch);
    expect(out.ok).toBe(true);
    expect((out.data as { content: { exit_code: number } }).content.exit_code).not.toBe(0);
  });

  it('AC-45 敏感路径上传在申请阶段被 block（-32004，入口不发放）', async () => {
    const out = await dispatchNativeTool(
      tool('host.request_upload'),
      { asset: 'web-01', remote_path: '/etc/cron.d/evil', size_bytes: 100 },
      PRINCIPAL,
      ctx.dispatch,
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe(-32004);
    expect(out.rule?.ruleName).toContain('敏感路径');
  });

  it('AC-42 超限：声明 300MB → -32007 入口不发放', async () => {
    const out = await dispatchNativeTool(
      tool('host.request_upload'),
      { asset: 'web-01', remote_path: '/tmp/big.bin', size_bytes: 314572800 },
      PRINCIPAL,
      ctx.dispatch,
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe(-32007);
  });

  it('AC-40/41/43/46 上传三步：申请→PUT→status done；文件不进 MCP；token 单次；审计三事件', async () => {
    const data = 'payload-abc-123\n';
    const req = await dispatchNativeTool(
      tool('host.request_upload'),
      { asset: 'web-01', remote_path: '/tmp/opsgate-upload.txt', size_bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') },
      PRINCIPAL,
      ctx.dispatch,
    );
    expect(req.ok).toBe(true);
    const info = (req.data as { content: { upload_id: string; headers: { Authorization: string } } }).content;
    // AC-40：申请响应与上报内容均不含文件体
    expect(JSON.stringify(info)).not.toContain('payload-abc-123');

    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/mcp/transfer/${info.upload_id}`,
      headers: {
        authorization: info.headers.Authorization,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from(data),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data.status).toBe('done');

    // 文件页原子落位：cat 回读一致
    const cat = await dispatchNativeTool(tool('host.execute_command'), { asset: 'web-01', command: 'cat /tmp/opsgate-upload.txt' }, PRINCIPAL, ctx.dispatch);
    expect((cat.data as { content: { stdout: string } }).content.stdout).toBe(data);

    const st = await dispatchNativeTool(tool('host.upload_status'), { asset: 'web-01', upload_id: info.upload_id }, PRINCIPAL, ctx.dispatch);
    expect((st.data as { content: { status: string } }).content.status).toBe('done');

    // AC-43：同 token 第二次 PUT → 401
    const dupe = await ctx.app.inject({
      method: 'PUT',
      url: `/mcp/transfer/${info.upload_id}`,
      headers: { authorization: info.headers.Authorization, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(data),
    });
    expect(dupe.statusCode).toBe(401);

    // AC-46：本次上传审计 ≥3 条（intent + 传输完成 + 落位完成）
    const rows = ctx.sqlite.prepare("SELECT action, status FROM audit_log_2026_10 WHERE server_id = 'srv-1' AND user_id = 'u-owner' ORDER BY ts").all() as Array<{ action: string; status: string }>;
    const transferEvents = rows.filter((r) => ['tool_call', 'transfer_upload', 'transfer_landed'].includes(r.action));
    expect(transferEvents.length).toBeGreaterThanOrEqual(3);
  });

  it('下载：申请→GET 一次成功→第二次 401（单次使用）', async () => {
    await dispatchNativeTool(tool('host.execute_command'), { asset: 'web-01', command: 'echo down-payload > /tmp/down.txt' }, PRINCIPAL, ctx.dispatch);
    const req = await dispatchNativeTool(tool('host.request_download'), { asset: 'web-01', remote_path: '/tmp/down.txt' }, PRINCIPAL, ctx.dispatch);
    expect(req.ok).toBe(true);
    const info = (req.data as { content: { download_id: string } }).content;
    // 下载入口以 url path 提供；token 经申请响应携带？request_download 返回 headers 省略——通过 service 取 token 不适合；改用入口 consume 路径：
    const service = ctx.transfer;
    const entry = service.get(info.download_id)!;
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/mcp/transfer/${info.download_id}`,
      headers: { authorization: `Bearer ${entry.token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.toString()).toBe('down-payload\n');
    const again = await ctx.app.inject({
      method: 'GET',
      url: `/mcp/transfer/${info.download_id}`,
      headers: { authorization: `Bearer ${entry.token}` },
    });
    expect(again.statusCode).toBe(401);
  });
});
