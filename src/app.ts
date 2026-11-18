/**
 * Fastify 应用装配（server.ts 与集成测试共用）。
 * 把 default-deny 注册表、根级 preHandler、认证/API Key/用户路由组装成可注入实例。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import * as schema from './db/schema.js';
import type { Auth } from './services/auth.js';
import { sessionPrincipal } from './services/auth.js';
import { verifyApiKey } from './services/apiKey.js';
import {
  assertPublicWhitelist,
  authorizeRequest,
  type AuthorizeContext,
  type RouteDefinition,
} from './routes/registry.js';
import { makeAuthHandler } from './routes/auth-handler.js';
import { healthzHandler } from './routes/health.js';
import { makeApiKeyRoutes } from './routes/apiKeys.js';
import { makeUserRoutes } from './routes/users.js';
import { makeTransferRoutes } from './routes/transfer.js';
import { makeSshRoutes } from './routes/servers.js';
import { makeRuntimeRoutes } from './routes/runtime.js';
import { makeStaticRoutes } from './routes/static.js';
import { makeMcpRoutes } from './routes/mcp.js';
import { makeSettingsRoutes } from './routes/settings.js';
import { makeGuardRuleRoutes } from './routes/guardRules.js';
import { makeAuditRoutes } from './routes/audit.js';
import { makeAssetRoutes, makeCredentialRoutes, makeGroupRoutes } from './routes/assets.js';
import { makeMarketRoutes } from './routes/market.js';
import { makeMarketAdminRoutes } from './routes/marketAdmin.js';
import { makeNativeToolRoutes } from './routes/nativeTools.js';
import type { Settings } from './config/settings.js';
import type { Database } from 'better-sqlite3';
import type { SshConnector } from './native/connectors/ssh.js';
import type { AuditService } from './services/audit.js';
import type { CredentialService } from './services/credentials.js';
import type { TransferService } from './services/transfer.js';
import type { InstancePool } from './services/instancePool.js';
import type { McpEndpoint } from './services/mcpEndpoint.js';

export interface AppDeps {
  db: BetterSQLite3Database<typeof schema>;
  auth: Auth;
  baseUrl: string;
  logLevel?: string;
  /** T5 实现 transfer-token 校验；缺省时一律 401（T3 占位） */
  verifyTransferToken?: AuthorizeContext['verifyTransferToken'];
  transfer?: TransferService;
  ssh?: SshConnector;
  credentials?: CredentialService;
  audit?: AuditService;
  settings?: Settings;
  cryptoKey?: Buffer;
  sqlite2?: never;
  instancePool?: InstancePool;
  mcp?: McpEndpoint;
  /** 审计查询需要 raw sqlite（跨月分表拼接） */
  sqlite?: Database;
  /** 前端构建产物目录（dist/frontend）；提供后注册静态 public 路由 */
  frontendDist?: string;
  runtimeCredsDir?: string;
  /** 原生工具注册表（/native-tools 管理端点；缺省不注册该端点） */
  nativeRegistry?: import('./framework/types.js').NativeToolDefinition[];
  /** 测试注入：自定义 Market 目录条目（默认加载 src/data/market-catalog.json） */
  marketEntries?: import('./services/marketCatalog.js').CatalogEntry[];
}

/** 未装配 McpEndpoint 的测试/骨架应用：/mcp 保持 501 占位（default-deny 语义不变） */
const mcpStubRoutes: RouteDefinition[] = (['GET', 'POST', 'DELETE'] as const).map((method) => ({
  method,
  url: '/mcp',
  accessMode: 'api-key',
  handler: (_req, reply) =>
    reply.code(501).send({ code: -32601, data: null, message: 'MCP 入口未装配（需 deps.mcp）' }),
}));

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, auth } = deps;
  const authHandler = makeAuthHandler(auth, async (username) => {
    // ADR-028 §2.5：登录成功后由调用方判断账号是否被禁用（此时密码已验证，不构成用户名枚举）
    const row = await db.select({ isDisabled: schema.users.isDisabled }).from(schema.users).where(eq(schema.users.username, username)).get();
    return row?.isDisabled === true;
  });
  const transferVerify: AuthorizeContext['verifyTransferToken'] =
    deps.verifyTransferToken ?? (async () => null);

  const routeDefs: RouteDefinition[] = [
    { method: 'GET', url: '/healthz', accessMode: 'public', handler: healthzHandler },
    {
      method: 'POST',
      url: '/api/v1/auth/sign-in/username',
      accessMode: 'public',
      handler: authHandler,
    },
    {
      method: 'ALL',
      url: '/api/v1/auth/*',
      accessMode: 'session',
      handler: authHandler,
    },
    ...makeApiKeyRoutes(db),
    ...makeUserRoutes(db, auth, deps.audit),
    ...makeSshRoutes({ db, credentials: deps.credentials! }),
    ...makeTransferRoutes({ db, transfer: deps.transfer!, ssh: deps.ssh!, credentials: deps.credentials!, audit: deps.audit! }),
    ...makeRuntimeRoutes({ pool: deps.instancePool, ssh: deps.ssh, transfer: deps.transfer, db, audit: deps.audit }),
    ...(deps.mcp ? makeMcpRoutes(deps.mcp) : mcpStubRoutes),
    ...(deps.frontendDist ? makeStaticRoutes(deps.frontendDist) : []),
    ...(deps.audit && deps.settings
      ? [
          ...makeSettingsRoutes({ db, settings: deps.settings, audit: deps.audit }),
          ...makeGuardRuleRoutes({ db, audit: deps.audit }),
          ...makeAuditRoutes(deps.sqlite!, deps.settings),
          ...(deps.nativeRegistry && deps.sqlite
            ? makeNativeToolRoutes({ db, sqlite: deps.sqlite, settings: deps.settings, audit: deps.audit, registry: deps.nativeRegistry })
            : []),
          ...makeAssetRoutes({ db, audit: deps.audit, cryptoKey: deps.cryptoKey ?? Buffer.alloc(0), pool: deps.instancePool, ssh: deps.ssh, credentials: deps.credentials, runtimeCredsDir: deps.runtimeCredsDir, settings: deps.settings, nativeRegistry: deps.nativeRegistry }),
          ...makeCredentialRoutes({ db, audit: deps.audit, cryptoKey: deps.cryptoKey ?? Buffer.alloc(0), pool: deps.instancePool, credentials: deps.credentials, settings: deps.settings }),
          ...makeGroupRoutes({ db, audit: deps.audit, cryptoKey: deps.cryptoKey ?? Buffer.alloc(0), pool: deps.instancePool, settings: deps.settings }),
          ...(deps.instancePool && deps.credentials
            ? makeMarketRoutes({
                db,
                settings: deps.settings,
                pool: deps.instancePool,
                credentials: deps.credentials,
                audit: deps.audit,
                runtimeCredsDir: deps.runtimeCredsDir ?? './data/runtime-creds',
                catalogEntries: deps.marketEntries,
              })
            : []),
          ...makeMarketAdminRoutes({
            db,
            pool: deps.instancePool,
            audit: deps.audit,
            runtimeCredsDir: deps.runtimeCredsDir ?? './data/runtime-creds',
          }),
        ]
      : []),
  ];
  assertPublicWhitelist(routeDefs);

  const app = Fastify({ logger: { level: deps.logLevel ?? 'warn' }, bodyLimit: 210 * 1024 * 1024 });
  // 文件传输旁路：二进制 PUT body（transfer-token 校验在 onRequest 钩子先于 body 解析）
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // R-1 第三层：根级兜底（未注册路径 → 403 而非 404）
  app.addHook('onRequest', async (req, reply) => {
    const ok = await authorizeRequest(req, reply, routeDefs, {
      getSessionUser: (headers) => sessionPrincipal(auth, headers),
      verifyApiKey: (token) => verifyApiKey(db, token),
      verifyTransferToken: transferVerify,
    });
    if (!ok) return reply; // 已 send 401/403，短路由
  });

  for (const d of routeDefs) {
    const method = d.method === 'ALL' ? ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'] : d.method;
    app.route({ method, url: d.url, handler: d.handler });
  }
  return app;
}
