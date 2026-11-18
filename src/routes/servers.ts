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

export function makeSshRoutes(deps: SshRouteDeps): RouteDefinition[] {
  const { db, credentials } = deps;
  return [
    {
      method: 'POST',
      url: '/api/v1/servers/:id/ssh/trust-fingerprint',
      accessMode: 'session',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const p = req.principal!;
        const row = await db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
        if (!row) return reply.code(404).send({ code: 404, data: null, message: '资产不存在' });
        if (row.ownerId !== p.userId && !p.isAdmin) {
          return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        }
        if (row.executionMode !== 'native' || !row.hostConn) {
          return reply.code(400).send({ code: 400, data: null, message: '该资产非原生执行配置' });
        }
        const hostConn = row.hostConn as { host: string; port?: number; username: string; authSlot?: string; authPassSlot?: string };
        const authSlot = hostConn.authSlot;
        if (!authSlot) {
          return reply.code(400).send({ code: 400, data: null, message: '未配置 authSlot（认证槽位）' });
        }
        let cred;
        let passphrase: string | undefined;
        try {
          // 归属人自己绑的 personal 凭证也要能用（否则 trust 会报"槽位未绑定"）
          const resolved = credentials.resolveSlotValues(id, [authSlot], p.userId);
          if (resolved.length === 0) throw new Error('槽位未绑定凭证');
          cred = resolved[0]!;
          // 加密私钥必须带上口令，否则 ssh2 报 "no passphrase given"。
          // 与连接器同口径：先按口令槽位绑定的凭证取 passphrase 键，再回落密码键本身。
          const passSlot = hostConn.authPassSlot;
          if (passSlot) {
            passphrase = credentials.slotCredentialKey(id, passSlot, 'passphrase', p.userId)?.value;
          }
          passphrase ??= credentials.credentialKey(cred.credentialId, 'passphrase') ?? undefined;
        } catch (err) {
          return reply.code(400).send({ code: 400, data: null, message: err instanceof Error ? err.message : '凭证解析失败' });
        }
        const credUsername = credentials.slotCredentialKey(id, authSlot, 'username', p.userId)?.value;
        let capturedKey: Buffer | null = null;
        try {
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
        } catch (err) {
          return reply.code(502).send({ code: 502, data: null, message: '连接失败：' + (err instanceof Error ? err.message : String(err)) });
        }
        if (!capturedKey) {
          return reply.code(502).send({ code: 502, data: null, message: '未捕获主机公钥（握手未完成）' });
        }
        const fp = fingerprintOf(capturedKey);
        await db
          .update(schema.servers)
          .set({ hostConn: { ...hostConn, hostFingerprint: fp } })
          .where(eq(schema.servers.id, id))
          .run();
        return reply.send({ code: 0, data: { id, fingerprint: fp }, message: 'ok' });
      },
    },
  ];
}
