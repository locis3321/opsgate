/**
 * 共享服务实例定位器（工具经此取 transfer 等服务实例；避免 import 具体构造逻辑）。
 */
import type { TransferService } from './transfer.js';

let transfer: TransferService | null = null;

export function setTransferService(instance: TransferService): void {
  transfer = instance;
}

export function getTransferService(): TransferService {
  if (!transfer) throw new Error('TransferService 未初始化');
  return transfer;
}
