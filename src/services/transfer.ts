/**
 * 文件传输旁路服务（§5.5.7）：一次性 transfer token（32B，绑 {userId, assetId, path, direction}，
 * TTL 5min，单次使用）；暂存区 <data>/transfer-staging/（0700，配额 2GB，TTL 15min 清理）；
 * 尺寸与 sha256 强校验（申请时声明，PUT 实际超声明 → 暂存删除并作废）。
 * 上传三事件（request intent / 传输完成 / 落位完成）由审计服务承载（dispatch + 路由分别落）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TRANSFER_STAGING_DIRNAME, TRANSFER_TOKEN_BYTES } from '../config/constants.js';
import type { SettingsLike } from '../config/settings.js';

export type TransferStatus = 'awaiting_upload' | 'received' | 'pushing' | 'done' | 'failed';
export type TransferDirection = 'upload' | 'download';

export class TransferLimitError extends Error {}
export class TransferTokenError extends Error {}
export class TransferSizeMismatchError extends Error {}

export interface TransferEntry {
  id: string;
  token: string;
  userId: string;
  assetId: string;
  remotePath: string;
  direction: TransferDirection;
  status: TransferStatus;
  declaredSize?: number;
  actualSize?: number;
  declaredSha256?: string;
  actualSha256?: string;
  stagingPath: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  error?: string;
}

export interface TransferConfig {
  dataDir: string;
  maxFileBytes: number;
  entryTtlMs: number;
  stagingQuotaBytes: number;
  stagingTtlMs: number;
}

export class TransferService {
  private entries = new Map<string, TransferEntry>();
  private tokenByHash = new Map<string, TransferEntry>();
  readonly stagingDir: string;

  constructor(
    private readonly config: TransferConfig,
    /** ADR-024 热生效源：提供后 max/ttl/quota 逐次读取 */
    private readonly settingsSrc: SettingsLike | null = null,
  ) {
    this.stagingDir = path.join(config.dataDir, TRANSFER_STAGING_DIRNAME);
    mkdirSync(this.stagingDir, { recursive: true, mode: 0o700 });
  }

  private hot<K extends 'transfer.max_file_bytes' | 'transfer.entry_ttl_sec' | 'transfer.staging_quota_bytes' | 'transfer.staging_ttl_sec'>(key: K): number {
    if (this.settingsSrc) return this.settingsSrc.get<number>(key);
    const map: Record<K, number> = {
      'transfer.max_file_bytes': this.config.maxFileBytes,
      'transfer.entry_ttl_sec': this.config.entryTtlMs / 1000,
      'transfer.staging_quota_bytes': this.config.stagingQuotaBytes,
      'transfer.staging_ttl_sec': this.config.stagingTtlMs / 1000,
    } as Record<K, number>;
    return map[key];
  }

  createUpload(input: {
    userId: string;
    assetId: string;
    remotePath: string;
    declaredSize: number;
    declaredSha256?: string;
  }): TransferEntry {
    if (input.declaredSize > this.hot('transfer.max_file_bytes')) {
      throw new TransferLimitError(`文件超出上限（${this.hot('transfer.max_file_bytes')} 字节）`);
    }
    if (input.remotePath.length === 0) throw new TransferLimitError('remote_path 不能为空');
    this.assertStagingQuota(input.declaredSize);
    const entry = this.entry(input.userId, input.assetId, input.remotePath, 'upload');
    entry.declaredSize = input.declaredSize;
    entry.declaredSha256 = input.declaredSha256;
    this.put(entry);
    return entry;
  }

  createDownload(input: {
    userId: string;
    assetId: string;
    remotePath: string;
    size: number;
    sha256: string;
    data: Buffer;
  }): TransferEntry {
    if (input.size > this.hot('transfer.max_file_bytes')) {
      throw new TransferLimitError(`文件超出下载上限（${this.hot('transfer.max_file_bytes')} 字节）`);
    }
    this.assertStagingQuota(input.size);
    const entry = this.entry(input.userId, input.assetId, input.remotePath, 'download');
    entry.declaredSize = input.size;
    entry.declaredSha256 = input.sha256;
    entry.actualSize = input.size;
    entry.actualSha256 = input.sha256;
    entry.stagingPath = this.stagePath(input.userId, 'download');
    writeFileSync(entry.stagingPath, input.data, { mode: 0o600 });
    entry.status = 'done';
    this.put(entry);
    return entry;
  }

  get(id: string): TransferEntry | undefined {
    return this.entries.get(id);
  }

  /** 单次使用校验：方向一致 + 未过期 + 未使用（AC-43） */
  consume(token: string, direction: TransferDirection): TransferEntry {
    const hash = hashToken(token);
    const entry = this.tokenByHash.get(hash);
    if (!entry) throw new TransferTokenError('无效 transfer token');
    if (entry.direction !== direction) throw new TransferTokenError('transfer token 方向不符');
    if (entry.used || Date.now() > entry.expiresAt) throw new TransferTokenError('transfer token 已使用或过期');
    entry.used = true;
    return entry;
  }

  /** PUT 落暂存：实际字节与声明不符 → 删除并失败（AC-42） */
  receive(id: string, body: Buffer): { actualSize: number; sha256: string } {
    const entry = this.required(id);
    if (entry.status !== 'awaiting_upload') throw new TransferTokenError('入口状态非法');
    const actualSize = body.length;
    const sha = sha256Of(body);
    if (entry.declaredSize !== undefined && actualSize > entry.declaredSize) {
      this.fail(entry, '实际字节数超过声明值');
      throw new TransferSizeMismatchError('实际字节数超过声明值');
    }
    if (entry.declaredSha256 && entry.declaredSha256 !== sha) {
      this.fail(entry, 'sha256 不匹配');
      throw new TransferSizeMismatchError('sha256 不匹配');
    }
    writeFileSync(entry.stagingPath, body, { mode: 0o600 });
    entry.actualSize = actualSize;
    entry.actualSha256 = sha;
    entry.status = 'received';
    return { actualSize, sha256: sha };
  }

  markPushing(id: string): void {
    const entry = this.required(id);
    entry.status = 'pushing';
  }

  complete(id: string, ok: boolean, error?: string): void {
    const entry = this.required(id);
    if (ok) {
      entry.status = 'done';
      this.cleanupFile(entry);
    } else {
      this.fail(entry, error ?? '落位失败');
    }
  }

  /** 暂存文件路径（PUT/GET 路由读） */
  stagingFileOf(entry: TransferEntry): string {
    return entry.stagingPath;
  }

  /** 暂存区摘要：文件数 / 占用字节 / 待处理入口数（`/runtime/transfer-staging`） */
  stagingStats(): { entries: number; files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    let names: string[] = [];
    try {
      names = readdirSync(this.stagingDir);
    } catch {
      // 目录尚不存在
    }
    for (const name of names) {
      try {
        const st = statSync(path.join(this.stagingDir, name));
        if (st.isFile()) {
          files++;
          bytes += st.size;
        }
      } catch {
        // 并发删除竞态，忽略
      }
    }
    return { entries: this.entries.size, files, bytes };
  }

  /** 周期清理：过期入口 + 暂存 TTL 文件 + 配额检查（16 分钟起步，sweeper 由 server 启动） */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (now > entry.expiresAt || (entry.status === 'failed')) {
        this.cleanupFile(entry);
        this.entries.delete(id);
        this.tokenByHash.delete(hashToken(entry.token));
        removed++;
      }
    }
    // 暂存目录孤儿文件（超时）
    for (const f of listFiles(this.stagingDir)) {
      if (now - f.mtimeMs > this.hot('transfer.staging_ttl_sec') * 1000) {
        try {
          rmSync(f.path, { force: true });
        } catch {
          // 正在使用
        }
      }
    }
    return removed;
  }

  /**
   * 暂存配额校验（transfer.staging_quota_bytes）。
   *
   * 在**申请入口就校验**，而不是等 PUT 写完再判断：写满磁盘再拒绝等于已经产生了副作用，
   * 且需要回滚删除。这里的占用是"当前暂存目录实际字节 + 本次声明大小"。
   */
  private assertStagingQuota(incomingBytes: number): void {
    const quota = this.hot('transfer.staging_quota_bytes');
    const used = this.stagingUsage().bytes;
    if (used + incomingBytes > quota) {
      throw new TransferLimitError(
        `暂存区空间不足（已用 ${used} 字节 + 本次 ${incomingBytes} 字节 > 配额 ${quota} 字节）`,
      );
    }
  }

  stagingUsage(): { bytes: number; files: number } {
    let bytes = 0;
    let files = 0;
    for (const f of listFiles(this.stagingDir)) {
      bytes += f.size;
      files++;
    }
    return { bytes, files };
  }

  private entry(userId: string, assetId: string, remotePath: string, direction: TransferDirection): TransferEntry {
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(TRANSFER_TOKEN_BYTES).toString('base64url');
    const now = Date.now();
    return {
      id,
      token,
      userId,
      assetId,
      remotePath,
      direction,
      status: direction === 'upload' ? 'awaiting_upload' : 'done',
      stagingPath: this.stagePath(userId, direction),
      createdAt: now,
      // 热读：schema 把 entry_ttl_sec 标为热生效，用构造快照会让"改了 TTL 没反应"
      expiresAt: now + this.hot('transfer.entry_ttl_sec') * 1000,
      used: false,
    };
  }

  private put(entry: TransferEntry): void {
    this.entries.set(entry.id, entry);
    this.tokenByHash.set(hashToken(entry.token), entry);
  }

  private required(id: string): TransferEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new TransferTokenError('入口不存在或已过期');
    return entry;
  }

  private fail(entry: TransferEntry, error: string): void {
    entry.status = 'failed';
    entry.error = error;
    this.cleanupFile(entry);
  }

  private cleanupFile(entry: TransferEntry): void {
    if (entry.stagingPath && existsSync(entry.stagingPath)) {
      try {
        rmSync(entry.stagingPath, { force: true });
      } catch {
        // 忽略
      }
    }
  }

  private stagePath(userId: string, direction: TransferDirection): string {
    return path.join(this.stagingDir, `${direction}-${userId.slice(0, 8)}-${randomBytes(8).toString('hex')}`);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function listFiles(dir: string): Array<{ path: string; size: number; mtimeMs: number }> {
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile()) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // 并发删除
    }
  }
  return out;
}
