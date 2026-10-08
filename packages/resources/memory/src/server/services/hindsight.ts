/** Hindsight 记忆服务配置与 Bank/转发管理 */

import { getMemoryConfig } from "../config";

/** 「未配置」的领域文案：模块配置缺少 `hindsightMcpUrl` 时的唯一一份说明。 */
export const HINDSIGHT_NOT_CONFIGURED_MESSAGE = "Hindsight 未配置：memory 模块配置缺少 hindsightMcpUrl";

/**
 * 读取 Hindsight 服务地址，未配置返回 null。
 *
 * 值来自 `getModuleConfig("memory")`（宿主在装配阶段注入 `HINDSIGHT_MCP_URL` 的解析结果）；
 * 本包不读 `process.env`：包内的环境读取会让「包认为已配置、宿主认为未配置」的分歧只能等到
 * 运行期以 503 的形式暴露。
 */
export function getHindsightConfig(): { url: string } | null {
  const { hindsightMcpUrl } = getMemoryConfig();
  if (!hindsightMcpUrl) return null;
  return { url: hindsightMcpUrl };
}

// 不预创建 bank：插件 src/lib/bank.ts 的 ensureBankMission 明确约定首次 retain 自动创建。
// 启动路径不应为尚无记忆的成员发 PUT；缺失 bank 的首次 recall 由插件按无记忆处理。

/**
 * 通用 Hindsight API 转发。构造目标 URL 并转发请求。
 * 调用方负责传入正确的 path。
 */
export async function proxyToHindsight(path: string, options?: RequestInit): Promise<Response> {
  const config = getHindsightConfig();
  if (!config) {
    throw new Error("Hindsight 未配置：memory 模块配置缺少 hindsightMcpUrl");
  }
  return fetch(`${config.url}${path}`, options);
}
