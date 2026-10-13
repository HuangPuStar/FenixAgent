// file-ws-port.ts — file-ws 传输能力对「文件路由决策」这一侧的最小接口
//
// 为什么需要这一层：远程文件操作的两个原语（连接查询 `isFileWsConnected`、请求应答
// `sendFileOpAndWait`）既被本包门面调用，又被宿主测试替换——宿主侧走的是模块级 mock
// （`apps/server/src/test-utils/setup-mocks.ts` 按解析后的真实路径替换本包模块导出），而包内用例
// 不得依赖宿主内部机制。把两者收敛为一个包内可替换句柄后：
//   - 默认实现按调用时读取模块导出（live binding），宿主的模块级 mock 仍然生效；
//   - 包内用例经 `@fenix/resource-machine/server/testing` 的 `stubFileWsTransport` 直接替换，
//     不需要运行 WS 服务器，也不受宿主 preload 是否装载影响。
// 接口只含这两个原语：连接登记与帧处理是传输模块自身职责，不在本文件另开入口。

import { isFileWsConnected as readIsFileWsConnected } from "./file-ws-handler";
import { type FileOpOptions, type FileOpResult, sendFileOpAndWait as sendFileOpAndWaitReal } from "./file-ws-requests";

// 调用方（远程文件服务）只面向本文件即可：请求参数与回执类型随能力一起转出，
// 避免同一服务模块分散依赖传输内部模块。
export type { FileOpOptions, FileOpResult };

/** file-ws 传输能力的可替换句柄。 */
export interface FileWsTransportPort {
  /** 机器是否有活跃的 file-ws 连接（远程路由决策的前置条件）。 */
  isFileWsConnected(machineId: string): boolean;
  /** 发送一次 file_op 并等待机器端回执；超时/断连的重试编排在实现内。 */
  sendFileOpAndWait(
    machineId: string,
    operation: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
    options?: FileOpOptions,
  ): Promise<FileOpResult>;
}

let override: Partial<FileWsTransportPort> | null = null;

/**
 * 替换传输实现（测试装配用）。
 *
 * 浅合并语义：只传需要替换的原语；传 `null` 恢复为包内真实实现。复位统一走
 * `@fenix/resource-machine/server/testing` 登记的 `registerStubResetter`，避免用例之间的配置泄漏。
 */
export function setFileWsTransport(overrides: Partial<FileWsTransportPort> | null): void {
  override = overrides ? { ...override, ...overrides } : null;
}

/** 读取当前生效的传输实现（替换值优先，否则为包内真实实现）。 */
export function getFileWsTransport(): FileWsTransportPort {
  return {
    isFileWsConnected: (machineId) => (override?.isFileWsConnected ?? readIsFileWsConnected)(machineId),
    sendFileOpAndWait: (machineId, operation, params, timeoutMs, options) =>
      (override?.sendFileOpAndWait ?? sendFileOpAndWaitReal)(machineId, operation, params, timeoutMs, options),
  };
}

/** 连接查询（走当前生效的传输实现）。 */
export function isFileWsConnected(machineId: string): boolean {
  return getFileWsTransport().isFileWsConnected(machineId);
}

/** 文件操作请求（走当前生效的传输实现）。 */
export function sendFileOpAndWait(
  machineId: string,
  operation: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
  options?: FileOpOptions,
): Promise<FileOpResult> {
  return getFileWsTransport().sendFileOpAndWait(machineId, operation, params, timeoutMs, options);
}
