import { createCcbCompatibleHandler } from "@fenix/ccb";
import type { EngineHandler } from "acp-link/client/instance-manager";

export interface PeriHandlerOptions {
  command: string;
  args: string[];
}

/**
 * 创建 Peri 的 ACP handler。
 *
 * Peri 使用 CCB-compatible 的 workspace、skills、MCP、权限与 relay 协议；
 * Peri 的二进制、参数和引擎身份仅由本插件定义。
 */
export function createPeriHandler(options: PeriHandlerOptions): EngineHandler {
  return createCcbCompatibleHandler({
    ...options,
    logLabel: "peri",
  });
}
