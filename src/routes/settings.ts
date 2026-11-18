/**
 * 系统设置端点（§5.10.7 / ADR-024，admin-only）：
 * GET /settings（schema + 当前生效值 + 默认 + pending）；PATCH /settings/:key（类型/范围/options 校验，
 * 非法 → -32008 且不落库（AC-57）；write-ahead 审计 before/after，secret 记 ***）；POST reset（删行回默认）；
 * GET /settings/pending-restart（requires_restart 且已保存 ≠ 生效 的项，AC-60 数据源）。
 * 非 admin → 403（§5.10.7，非 404）。
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as schema from '../db/schema.js';
import type { Settings } from '../config/settings.js';
import { SETTINGS_SCHEMA, SETTINGS_BY_KEY, type SettingDef } from '../config/settingsSchema.js';

import type { AuditService } from '../services/audit.js';
import { ERROR_CODES } from '../config/constants.js';
import type { RouteDefinition } from './registry.js';

export class SettingValidationError extends Error {
  constructor(
    public readonly key: string,
    message: string,
  ) {
    super(message);
  }
}

/** 校验并归一化输入（类型/范围/options；不做静默夹取——AC-57 越界即 -32008 不落库） */
export function coerceSettingValue(def: SettingDef, raw: unknown): unknown {
  let value = raw;
  switch (def.type) {
    case 'int':
    case 'size':
    case 'duration':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new SettingValidationError(def.key, `期望数字`);
      if (def.type === 'int' || def.type === 'size') {
        if (!Number.isInteger(raw)) throw new SettingValidationError(def.key, '期望整数');
      } else if (raw < 0) {
        throw new SettingValidationError(def.key, '期望非负数');
      }
      break;
    case 'float':
      if (typeof raw !== 'number') throw new SettingValidationError(def.key, '期望浮点数');
      break;
    case 'bool':
      if (typeof raw !== 'boolean') throw new SettingValidationError(def.key, '期望布尔');
      break;
    case 'string':
      if (typeof raw !== 'string') throw new SettingValidationError(def.key, '期望字符串');
      break;
    case 'json':
      if (typeof raw === 'string') {
        try {
          value = JSON.parse(raw);
        } catch {
          throw new SettingValidationError(def.key, '期望合法 JSON');
        }
      }
      break;
  }
  if (typeof value === 'number') {
    if (def.min !== undefined && value < def.min) throw new SettingValidationError(def.key, `低于下限 ${def.min}`);
    if (def.max !== undefined && value > def.max) throw new SettingValidationError(def.key, `超出上限 ${def.max}`);
  }
  if (def.options && def.options.length > 0 && !def.options.includes(value as string | number)) {
    throw new SettingValidationError(def.key, `不在可选值内`);
  }
  return value;
}

export interface SettingsRouteDeps {
  db: BetterSQLite3Database<typeof schema>;
  settings: Settings;
  audit: AuditService;
}

export function makeSettingsRoutes(deps: SettingsRouteDeps): RouteDefinition[] {
  const { db, settings, audit } = deps;

  const persisted = async () => {
    const rows = await db.select().from(schema.systemSettings);
    return new Map(rows.map((r) => [r.key, r]));
  };

  return [
    {
      method: 'GET',
      url: '/api/v1/settings',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const rows = await persisted();
        const data = SETTINGS_SCHEMA.map((def) => {
          const row = rows.get(def.key);
          const saved = row ? safeParse(row.value) : def.default;
          // 生效值以 settings.get 为准：requires_restart 项 PATCH 后未重启 → 仍为默认值（DB 值待生效）
          const current = settings.get(def.key);
          return {
            key: def.key,
            category: def.category,
            type: def.type,
            label: def.label,
            description: def.description,
            default: def.default,
            min: def.min ?? null,
            max: def.max ?? null,
            options: def.options ?? null,
            requiresRestart: def.requiresRestart,
            secret: def.secret,
            current,
            saved,
            pendingRestart: def.requiresRestart && row !== undefined && JSON.stringify(current) !== JSON.stringify(saved),
            stored: row !== undefined,
          };
        });
        return reply.send({ code: 0, data, message: 'ok' });
      },
    },
    {
      method: 'PATCH',
      url: '/api/v1/settings/:key',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        const def = SETTINGS_BY_KEY.get(key);
        if (!def) {
          return reply.code(400).send({ code: ERROR_CODES.settingsInvalid, data: null, message: `配置项不存在: ${key}` });
        }
        const body = req.body as { value?: unknown };
        let value: unknown;
        try {
          value = coerceSettingValue(def, body.value);
        } catch (err) {
          const message = err instanceof Error ? err.message : '校验失败';
          return reply.code(400).send({ code: ERROR_CODES.settingsInvalid, data: null, message: `配置校验失败（不落库）: ${message}` });
        }

        // write-ahead 审计（before/after；secret 记 ***）
        const before = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).get();
        const beforeValue = before ? safeParse(before.value) : def.default;
        try {
          await audit.writeIntent({
            principal: req.principal!,
            asset: { id: 'settings', name: 'system_settings' },
            tool: 'system_setting',
            // 字段名用 name（通用脱敏的 /key/ 会命中 "key" 字段并打码，配置审计必须保留键名可见）
            args: {
              name: key,
              before: def.secret ? '***' : beforeValue,
              after: def.secret ? '***' : value,
            },
            risk: 'normal',
            status: 'success',
            action: 'system_setting',
          });
        } catch {
          return reply.code(500).send({ code: ERROR_CODES.auditUnavailable, data: null, message: 'Audit unavailable; change refused' });
        }

        // 落库（只存偏离默认值行：等于默认则删行；否则 upsert）
        const json = JSON.stringify(value);
        const hits = before;
        if (JSON.stringify(value) === JSON.stringify(def.default)) {
          if (hits) await db.delete(schema.systemSettings).where(eq(schema.systemSettings.key, key)).run();
        } else if (hits) {
          await db
            .update(schema.systemSettings)
            .set({ value: json, updatedBy: req.principal!.userId, updatedAt: new Date() })
            .where(eq(schema.systemSettings.key, key))
            .run();
        } else {
          await db
            .insert(schema.systemSettings)
            .values({
              key,
              value: json,
              valueType: def.type,
              category: def.category,
              defaultValue: JSON.stringify(def.default),
              minValue: def.min ?? null,
              maxValue: def.max ?? null,
              options: def.options ? JSON.stringify(def.options) : null,
              isSecret: def.secret,
              requiresRestart: def.requiresRestart,
              updatedBy: req.principal!.userId,
              updatedAt: new Date(),
            })
            
            .run();
        }
        settings.invalidate();
        if (!def.requiresRestart) settings.setCache(key, value); // AC-55 热生效
        return reply.send({ code: 0, data: { key, value, hot: !def.requiresRestart }, message: 'ok' });
      },
    },
    {
      method: 'POST',
      url: '/api/v1/settings/:key/reset',
      accessMode: 'admin',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { key } = req.params as { key: string };
        const def = SETTINGS_BY_KEY.get(key);
        if (!def) {
          return reply.code(400).send({ code: ERROR_CODES.settingsInvalid, data: null, message: `配置项不存在: ${key}` });
        }
        const before = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).get();
        if (before) {
          await audit.writeIntent({
            principal: req.principal!,
            asset: { id: 'settings', name: 'system_settings' },
            tool: 'system_setting',
            args: { name: key, before: def.secret ? '***' : safeParse(before.value), after: def.secret ? '***' : def.default },
            risk: 'normal',
            status: 'success',
            action: 'system_setting',
          });
          await db.delete(schema.systemSettings).where(eq(schema.systemSettings.key, key)).run();
          settings.invalidate();
        }
        return reply.send({ code: 0, data: { key, default: def.default }, message: 'ok' });
      },
    },
    {
      method: 'GET',
      url: '/api/v1/settings/pending-restart',
      accessMode: 'admin',
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        const rows = await persisted();
        const pending = SETTINGS_SCHEMA.filter((def) => {
          if (!def.requiresRestart || !rows.has(def.key)) return false;
          // 已保存 ≠ 生效（重启后 init 会把 DB 值载入生效，此时为空）
          return JSON.stringify(settings.get(def.key)) !== JSON.stringify(safeParse(rows.get(def.key)!.value));
        }).map((def) => ({
          key: def.key,
          saved: safeParse(rows.get(def.key)!.value),
          effective: settings.get(def.key),
        }));
        return reply.send({ code: 0, data: { pending }, message: 'ok' });
      },
    },
  ];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
