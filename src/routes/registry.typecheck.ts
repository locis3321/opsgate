/**
 * 编译期断言：RouteDefinition.accessMode 必填（default-deny R-1 第一层）。
 * 若签名放开必填，下方 @ts-expect-error 将变成 "未使用的指令" 错误 → typecheck 失败。
 */
import type { RouteDefinition } from './registry.js';

// @ts-expect-error accessMode 必须显式声明（R-1）
const badRoute: RouteDefinition = {
  method: 'GET',
  url: '/api/v1/rogue',
  handler: () => undefined,
};
void badRoute;
