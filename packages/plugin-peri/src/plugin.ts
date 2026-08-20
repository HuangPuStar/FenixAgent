import { createCcbCompatibleRuntime } from "@fenix/ccb";
import type { EnginePlugin } from "@fenix/plugin-sdk";

export interface PeriPluginOptions {
  command?: string;
  args?: string[];
}

/**
 * 创建 Peri engine plugin。
 *
 * Peri 是独立 engine type；runtime 复用 CCB-compatible ACP 基础设施，
 * 但 Peri 的二进制和引擎元信息由本插件独立维护。
 */
export function createEnginePlugin(options: PeriPluginOptions = {}): EnginePlugin {
  const command = options.command ?? "peri";
  const args = options.args ?? ["acp"];

  return {
    meta: {
      id: "peri",
      displayName: `Peri Engine (${command} ${args.join(" ")})`,
      version: "0.1.0",
    },
    createRuntime() {
      return createCcbCompatibleRuntime({ command, args });
    },
  };
}
