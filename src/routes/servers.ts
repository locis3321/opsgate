/**
 * 主机 SSH 相关管理端点：指纹信任（§5.5.7，AC-47）。
 * 管理端"连通性测试"显式 trust：连接捕获主机公钥 → 计算 SHA256 指纹 → 写入 host_conn.hostFingerprint；
 * 后续连接不一致/未信任 → 拒绝（不做自动信任）。
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Client } from 'ssh2';
import * as schema from '../db/schema.js';
import type { CredentialService } from '../services/credentials.js';
import { fingerprintOf, sshAuthParams } from '../native/connectors/ssh.js';
import type { RouteDefinition } from './registry.js';

export interface SshRouteDeps {
  db: BetterSQLite3Database<typeof schema>;
  credentials: CredentialService;
}

type ServerRow = typeof schema.servers.$inferSelect;
type Principal = { userId: string; isAdmin: boolean };

/** 批量信任的单台结果分类：skip = 不是可信任的目标（非原生主机 / 缺配置），不是失败 */
export type TrustOutcome =
  | { status: 'ok'; fingerprint: string }
  | { status: 'skip'; reason: string };

/**
 * 采集单台主机的公钥并写入指纹。
 * 失败抛错（凭证解析失败 / 握手失败 / 未捕获公钥），由调用方决定 abort 还是计入 failed。
 */
export async function trustFingerprintFor(
  deps: SshRouteDeps,
  row: ServerRow,
  principal: Principal,
): Promise<TrustOutcome> {
  if (row.executionMode !== 'native' || !row.hostConn) {
    return { status: 'skip', reason: '非原生执行配置（无 SSH 连接）' };
  }
  const hostConn = row.hostConn as { host: string; port?: number; username: string; authSlot?: string; authPassSlot?: string };
  const authSlot = hostConn.authSlot;
  if (!authSlot) return { status: 'skip', reason: '未配置 authSlot（认证槽位）' };

  // 归属人自己绑的 personal 凭证也要能用（否则 trust 会报"槽位未绑定"）
  const resolved = deps.credentials.resolveSlotValues(row.id, [authSlot], principal.userId);
  if (resolved.length === 0) throw new Error('槽位未绑定凭证');
  const cred = resolved[0]!;
  // 加密私钥必须带上口令，否则 ssh2 报 "no passphrase given"。
  // 与连接器同口径：先按口令槽位绑定的凭证取 passphrase 键，再回落密码键本身。
  let passphrase: string | undefined;
  const passSlot = hostConn.authPassSlot;
  if (passSlot) {
    passphrase = deps.credentials.slotCredentialKey(row.id, passSlot, 'passphrase', principal.userId)?.value;
  }
  passphrase ??= deps.credentials.credentialKey(cred.credentialId, 'passphrase') ?? undefined;
  const credUsername = deps.credentials.slotCredentialKey(row.id, authSlot, 'username', principal.userId)?.value;

  let capturedKey: Buffer | null = null;
  await new Promise<void>((resolve, reject) => {
    const c = new Client();
    c.once('ready', () => {
      c.end();
      resolve();
    });
    c.once('error', (err) => reject(err));
    c.connect({
      ...sshAuthParams(hostConn, { value: cred.value, username: credUsername ?? undefined }, passphrase),
      readyTimeout: 10_000,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        capturedKey = key;
        verify(true); // 信任采集：接受并捕获公钥 blob
      },
    });
  });
  if (!capturedKey) throw new Error('未捕获主机公钥（握手未完成）');
  const fp = fingerprintOf(capturedKey);
  await deps.db
    .update(schema.servers)
    .set({ hostConn: { ...hostConn, hostFingerprint: fp } })
    .where(eq(schema.servers.id, row.id))
    .run();
  return { status: 'ok', fingerprint: fp };
}

/** 批量信任的并发上限：单台最坏 10s，串行 200 台要半小时；再高容易触发目标 sshd 限流 */
const TRUST_CONCURRENCY = 4;

export function makeSshRoutes(deps: SshRouteDeps): RouteDefinition[] {
  const { db } = deps;

  type Loaded = { row: ServerRow } | { error: { code: number; message: string } };
  const loadOwned = async (id: string, p: Principal): Promise<Loaded> => {
    const row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!row) return { error: { code: 404, message: '资产不存在' } };
    if (row.ownerId !== p.userId && !p.isAdmin) return { error: { code: 403, message: 'Forbidden' } };
    return { row };
  };

  return [
    {
      method: 'POST',
      url: '/api/v1/servers/:id/ssh/trust-fingerprint',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const loaded = await loadOwned(id, req.principal!);
        if ('error' in loaded) return reply.code(loaded.error.code).send({ code: loaded.error.code, data: null, message: loaded.error.message });
        const row = loaded.row;
        if (row.executionMode !== 'native' || !row.hostConn) {
          return reply.code(400).send({ code: 400, data: null, message: '该资产非原生执行配置' });
        }
        try {
          const out = await trustFingerprintFor(deps, row, req.principal!);
          if (out.status === 'skip') {
            return reply.code(400).send({ code: 400, data: null, message: out.reason });
          }
          return reply.send({ code: 0, data: { id, fingerprint: out.fingerprint }, message: 'ok' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // 槽位/凭证解析失败属前置条件缺失（400），握手失败属下游不可达（502）
          const code = /凭证|槽位/.test(msg) ? 400 : 502;
          return reply.code(code).send({ code, data: null, message: code === 400 ? msg : '连接失败：' + msg });
        }
      },
    },
    {
      /**
       * 批量信任主机指纹（迁移后 126 台主机逐台点详情不现实）。
       * 逐台校验 owner/admin；非原生主机计入 skipped（不是失败）；其它错误计入 failed 且不中断其余台。
       */
      method: 'POST',
      url: '/api/v1/servers/ssh/trust-fingerprint-batch',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = req.principal!;
        const body = req.body as { ids?: unknown } | undefined;
        const rawIds = Array.isArray(body?.ids) ? body!.ids : [];
        const ids = rawIds.filter((x): x is string => typeof x === 'string' && x.length > 0);
        const unique = [...new Set(ids)].slice(0, 200);
        if (unique.length === 0) {
          return reply.code(400).send({ code: 400, data: null, message: 'ids 必须是非空字符串数组（上限 200）' });
        }

        const succeeded: Array<{ id: string; name: string; fingerprint: string }> = [];
        const failed: Array<{ id: string; name: string; reason: string }> = [];
        const skipped: Array<{ id: string; name: string; reason: string }> = [];

        // 先一次性把行读出来（同时做权限判定），再按并发上限分波执行握手
        type Job = { id: string; name: string; row?: ServerRow; failReason?: string };
        const jobs: Job[] = [];
        for (const id of unique) {
          const loaded = await loadOwned(id, p);
          if ('error' in loaded) {
            const reason = loaded.error.code === 403 ? '无权操作（仅归属人或管理员）' : loaded.error.message;
            jobs.push({ id, name: id, failReason: reason });
            continue;
          }
          jobs.push({ id, name: loaded.row.name, row: loaded.row });
        }

        const queue = [...jobs];
        const worker = async () => {
          for (;;) {
            const job = queue.shift();
            if (!job) return;
            if (job.failReason || !job.row) {
              failed.push({ id: job.id, name: job.name, reason: job.failReason ?? '资产不存在' });
              continue;
            }
            try {
              const out = await trustFingerprintFor(deps, job.row, p);
              if (out.status === 'skip') {
                skipped.push({ id: job.id, name: job.name, reason: out.reason });
              } else {
                succeeded.push({ id: job.id, name: job.name, fingerprint: out.fingerprint });
              }
            } catch (err) {
              failed.push({ id: job.id, name: job.name, reason: err instanceof Error ? err.message : String(err) });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(TRUST_CONCURRENCY, queue.length) }, () => worker()));

        return reply.send({
          code: 0,
          data: { succeeded, failed, skipped },
          message: 'ok',
        });
      },
    },
  ];
}
