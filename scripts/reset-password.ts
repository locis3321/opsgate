/**
 * 一次性运维脚本：重置指定账号的登录密码。
 *
 * 为什么走 better-auth 自身的 ctx.password.hash：密码算法（scrypt）与盐格式属于 better-auth 内部契约，
 * 自己实现哈希会与其校验路径脱节。此处只复用项目自身的 createAuth。
 *
 * 用法：npx tsx scripts/reset-password.ts <username> <newPassword>
 * 前置：服务已停止（避免 WAL 并发写），脚本会先备份数据库文件。
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/db/schema.js';
import { createAuth } from '../src/services/auth.js';
import { readBootstrap } from '../src/config/bootstrap.js';

async function main(): Promise<void> {
  const [username, newPassword] = process.argv.slice(2);
  if (!username || !newPassword) {
    throw new Error('用法：npx tsx scripts/reset-password.ts <username> <newPassword>');
  }
  if (newPassword.length < 10) {
    throw new Error('新密码至少 10 位（OPSGATE_ADMIN_INIT 同口径）');
  }

  const cfg = readBootstrap();
  if (!existsSync(cfg.dbPath)) throw new Error(`数据库不存在：${cfg.dbPath}`);
  const backup = `${cfg.dbPath}.bak-${Date.now()}`;
  copyFileSync(cfg.dbPath, backup);
  console.log(`已备份：${backup}`);

  const sqlite = new Database(cfg.dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });

  const user = db
    .select({ id: schema.users.id, username: schema.users.username, isAdmin: schema.users.isAdmin })
    .from(schema.users)
    .all()
    .find((u) => u.username === username);
  if (!user) {
    sqlite.close();
    throw new Error(`账号不存在：${username}`);
  }

  const auth = createAuth(sqlite, {
    secret: process.env.OPSGATE_SESSION_SECRET ?? 'reset-script-placeholder-secret-0123456789',
    baseUrl: `http://${cfg.bind}:${cfg.port}`,
  });
  const ctx = await auth.$context;
  const hashed = await ctx.password.hash(newPassword);

  // 账号表：providerId='credential' 的那条记录持有密码
  const acc = sqlite
    .prepare("SELECT id FROM account WHERE userId = ? AND providerId = 'credential'")
    .get(user.id) as { id: string } | undefined;
  if (!acc) {
    sqlite.close();
    throw new Error(`账号 ${username} 没有 credential 登录方式（可能为外部登录）`);
  }
  sqlite.prepare('UPDATE account SET password = ?, updatedAt = ? WHERE id = ?')
    .run(hashed, Date.now(), acc.id);

  // 清理该用户的既有会话：改密后强制重新登录
  const sessions = sqlite.prepare('DELETE FROM session WHERE userId = ?').run(user.id);

  // 回读自检
  const stored = sqlite.prepare('SELECT password FROM account WHERE id = ?').get(acc.id) as { password: string };
  const ok = await ctx.password.verify({ hash: stored.password, password: newPassword });
  sqlite.close();

  console.log(`账号 ${username}（${user.isAdmin ? '管理员' : '成员'}）密码已重置`);
  console.log(`已清理旧会话：${sessions.changes} 条`);
  console.log(`回读校验：${ok ? '通过' : '失败'}`);
  if (!ok) throw new Error('回读校验失败——密码未被正确写入');
}

main().catch((err) => {
  console.error('重置失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
