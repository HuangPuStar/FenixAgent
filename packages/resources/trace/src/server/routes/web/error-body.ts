import type { WebErr } from "@fenix/platform-sdk";

/**
 * `/web` 错误信封（`{ success: false, error: { code, message } }`）。
 *
 * 逐包保留一份：信封形状是 `/web` 的既有约定而非宿主私有逻辑，跨包引一个内部工具反而多一个耦合点
 * （与 `agent-config` 的 `buildWebErrorBody` 同口径，两处各自成文）。
 */
export function buildWebErrorBody(code: string, message: string): WebErr {
  return { success: false, error: { code, message } };
}
