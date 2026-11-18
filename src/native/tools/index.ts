/**
 * 原生工具自动加载（§5.9.5 目录约定）：src/native/tools/<category>/<id>.ts，
 * 默认导出即注册，**不手工登记**。跳过：_ 前缀文件（fixture/占位）、index、*.test.ts、*.d.ts。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NativeToolDefinition } from '../../framework/types.js';

const TOOLS_DIR = fileURLToPath(new URL('.', import.meta.url));

export async function loadNativeTools(): Promise<NativeToolDefinition[]> {
  const out: NativeToolDefinition[] = [];
  const categoryDirs = readdirSync(TOOLS_DIR, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && !e.name.startsWith('_'),
  );
  for (const dir of categoryDirs) {
    const toolDir = join(TOOLS_DIR, dir.name);
    const files = readdirSync(toolDir, { withFileTypes: true }).filter(
      (e) =>
        e.isFile() &&
        /\.(ts|js|mjs)$/.test(e.name) &&
        !e.name.startsWith('_') &&
        !e.name.endsWith('.test.ts') &&
        !e.name.endsWith('.d.ts'),
    );
    for (const f of files) {
      const mod = (await import(pathToFileURL(join(toolDir, f.name)).href)) as {
        default?: NativeToolDefinition;
        tool?: NativeToolDefinition;
      };
      const def = mod.default ?? mod.tool;
      if (!def || typeof def.execute !== 'function') continue;
      out.push(def);
    }
  }
  return out;
}
