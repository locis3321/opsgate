import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 配置（根级工具配置，非应用代码；AC-61 只扫描 src/）。
 * 生成迁移：pnpm exec drizzle-kit generate；应用迁移：pnpm run migrate。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.OPSGATE_DB_PATH ?? './data/opsgate.db',
  },
});
