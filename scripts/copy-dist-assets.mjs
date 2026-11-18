// tsc 不拷贝非 TS 资产：drizzle 迁移 SQL 与 meta/（_journal.json、快照）+ 内置 Market 目录
// 需同步进 dist，否则 `node dist/server.js` 启动时 migrate 找不到 _journal.json、catalog 找不到 market-catalog.json。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

function copyDir(src, dst) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
}

copyDir(path.resolve('src/db/migrations'), path.resolve('dist/db/migrations'));
copyDir(path.resolve('src/data'), path.resolve('dist/data'));
console.log('[copy-dist-assets] migrations + src/data -> dist');
