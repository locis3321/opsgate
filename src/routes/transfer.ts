/**
 * 文件传输旁路端点（§5.5.7）：PUT 上传（收包→校验→暂存→SFTP 推送→原子落位）／GET 下载（单次拉取）。
 * 注册为 transfer-token 访问模式（default-deny，T3 已预留）；
 * 文件本体不经过 MCP 工具参数（AC-40）；审计事件：申请(intent,dispatch) / 传输完成 / 落位完成（AC-46）。
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as schema from '../db/schema.js';
import type { AssetView } from '../framework/types.js';
import type { AuditService } from '../services/audit.js';
import type { CredentialService } from '../services/credentials.js';
import { SshConnector } from '../native/connectors/ssh.js';
import { TransferService } from '../services/transfer.js';
import type { RouteDefinition } from './registry.js';

export interface TransferRouteDeps {
  db: BetterSQLite3Database<typeof schema>;
  transfer: TransferService;
  ssh: SshConnector;
  credentials: CredentialService;
  audit: AuditService;
}

function assetToView(row: typeof schema.servers.$inferSelect): AssetView {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    ownerId: row.ownerId,
    executionMode: row.executionMode === 'mcp' ? 'mcp' : 'native',
    hostConn: (row.hostConn ?? null) as AssetView['hostConn'],
    url: row.url,
    env: (row.env ?? null) as Record<string, unknown> | null,
    args: (row.args ?? null) as unknown[] | null,
    headers: (row.headers ?? null) as Record<string, unknown> | null,
    credentialSlots: (row.credentialSlots ?? []) as AssetView['credentialSlots'],
    configHash: row.configHash,
  };
}

export function makeTransferRoutes(deps: TransferRouteDeps): RouteDefinition[] {
  const { db, transfer, ssh, credentials, audit } = deps;

  return [
    {
      method: 'PUT',
      url: '/mcp/transfer/:id',
      accessMode: 'transfer-token',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const entry = transfer.get(id);
        if (!entry || entry.direction !== 'upload') {
          return reply.code(404).send({ code: 401, data: null, message: '入口不存在或已过期' });
        }
        if (entry.userId !== req.principal?.userId) {
          return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        }
        const body = req.body as Buffer | null;
        if (!body) {
          return reply.code(400).send({ code: -32007, data: null, message: '请求体为空' });
        }
        let received;
        try {
          received = transfer.receive(id, body);
        } catch (err) {
          // 尺寸/sha256 不符：暂存删除并作废（AC-42/44）
          const message = err instanceof Error ? err.message : '校验失败';
          await auditEvent(audit, entry.userId, entry, 'transfer_upload', 'error', message);
          return reply.code(400).send({ code: -32007, data: null, message });
        }
        await auditEvent(audit, entry.userId, entry, 'transfer_upload', 'success', 'received');

        // SFTP 推送 + 原子 rename（同一 ssh connector／凭证注入）
        transfer.markPushing(id);
        try {
          const assetRow = await db
            .select()
            .from(schema.servers)
            .where(eq(schema.servers.id, entry.assetId))
            .get();
          if (!assetRow || assetRow.executionMode !== 'native') {
            throw new Error('资产不存在或非原生执行');
          }
          const asset = assetToView(assetRow);
          const authSlot = asset.hostConn?.authSlot;
          if (!authSlot) throw new Error('资产未配置认证槽位');
          credentials.resolveSlotValues(asset.id, [authSlot], entry.userId); // fail-closed：槽位未绑定则失败
          // 落位走的是发起传输的这个人当前实际生效的那套凭证（与工具调用同口径）
          const lease = await ssh.acquire(asset, authSlot, { userId: entry.userId, isAdmin: req.principal?.isAdmin === true });
          try {
            await lease.upload(entry.remotePath, body);
          } finally {
            ssh.release(lease);
          }
          transfer.complete(id, true);
          await auditEvent(audit, entry.userId, entry, 'transfer_landed', 'success', `path=${entry.remotePath}`);
          return reply.send({ code: 0, data: { upload_id: id, status: 'done', sha256: received.sha256 }, message: 'ok' });
        } catch (err) {
          transfer.complete(id, false, err instanceof Error ? err.message : '推送失败');
          await auditEvent(audit, entry.userId, entry, 'transfer_landed', 'error', err instanceof Error ? err.message : '推送失败');
          return reply.code(502).send({ code: 500, data: null, message: '推送失败：' + (err instanceof Error ? err.message : String(err)) });
        }
      },
    },
    {
      method: 'GET',
      url: '/mcp/transfer/:id',
      accessMode: 'transfer-token',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const entry = transfer.get(id);
        if (!entry || entry.direction !== 'download') {
          return reply.code(404).send({ code: 401, data: null, message: '入口不存在或已过期' });
        }
        if (entry.userId !== req.principal?.userId) {
          return reply.code(403).send({ code: 403, data: null, message: 'Forbidden' });
        }
        const file = transfer.stagingFileOf(entry);
        const { readFileSync, rmSync } = await import('node:fs');
        const buf = readFileSync(file);
        rmSync(file, { force: true }); // 单次使用（AC-43）
        transfer.complete(id, true);
        reply.header('content-type', 'application/octet-stream');
        reply.header('content-length', String(buf.length));
        return reply.send(buf);
      },
    },
  ];
}

/** 传输完成/落位审计事件（意图在 dispatch write-ahead 已落，此处分两条：传输完成、落位完成） */
async function auditEvent(
  audit: AuditService,
  userId: string,
  entry: { assetId: string; remotePath: string },
  action: string,
  status: 'success' | 'error',
  detail: string,
): Promise<void> {
  await audit.writeIntent({
    principal: { userId, isAdmin: false },
    asset: { id: entry.assetId, name: entry.assetId },
    tool: 'native:host.upload_status',
    args: { remote_path: entry.remotePath, detail },
    risk: status === 'error' ? 'high' : 'normal',
    status,
    action,
  });
}
