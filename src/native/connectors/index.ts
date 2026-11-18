/**
 * Connector 注册表（少而稳定）：T5 注册 ssh；框架按工具声明校验存在性。
 */
import type { Connector } from '../../framework/types.js';

export const CONNECTOR_REGISTRY = new Map<string, Connector<unknown>>();

export function registerConnector<H>(connector: Connector<H>): void {
  CONNECTOR_REGISTRY.set(connector.type, connector as Connector<unknown>);
}

export function hasConnector(type: string): boolean {
  return CONNECTOR_REGISTRY.has(type);
}
