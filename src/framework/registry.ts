/**
 * 工具注册表 + 启动 fail-fast 校验（§5.9.4）：
 * id 重复 / 声明的 connector 不存在 / 与派生工具同名 → 收集违规，调用方启动失败并打印。
 */
import type { NativeToolDefinition } from './types.js';
import { hasConnector } from '../native/connectors/index.js';
import { validateAll } from './validate.js';

export interface RegistryBuildResult {
  /** id → 定义 */
  registry: Map<string, NativeToolDefinition>;
  /** 违规清单（非空 = 启动失败） */
  errors: string[];
}

export function buildToolRegistry(
  tools: NativeToolDefinition[],
  derivedToolNames: string[] = [],
): RegistryBuildResult {
  const registry = new Map<string, NativeToolDefinition>();
  const errors: string[] = [];

  // R1–R8 静态校验（§5.9.4，CI + 启动）
  errors.push(...validateAll(tools));

  const seenNames = new Set<string>();
  for (const tool of tools) {
    if (registry.has(tool.id)) {
      errors.push(`工具 id 重复: ${tool.id}`);
      continue;
    }
    if (seenNames.has(tool.name)) {
      errors.push(`工具暴露名冲突: ${tool.name}`);
    }
    seenNames.add(tool.name);
    if (!hasConnector(tool.connector)) {
      errors.push(`工具 ${tool.id} 声明的 connector "${tool.connector}" 未注册`);
    }
    if (derivedToolNames.includes(tool.name)) {
      errors.push(`工具 ${tool.id} 与派生工具同名: ${tool.name}（原生优先原则，重复即违规）`);
    }
    registry.set(tool.id, tool);
  }
  return { registry, errors };
}
