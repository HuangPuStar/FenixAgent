/**
 * 云盘 MCP 的协议协商常量与 `server/discover` 结果。
 *
 * peri 4.4.1（rmcp 3.5.1）启动时先发 `server/discover` 并携带 `MCP-Protocol-Version: 2026-07-28`；
 * 本模块只声明该版本下的 **tools 子集**（initialize/tools/list/tools/call），不实现 resources 等其它能力。
 * 若客户端拿不到 discover，会回退到 `initialize`（rmcp Auto 策略），因此这条路径是兼容增强，不是唯一入口。
 *
 * 注意：`@modelcontextprotocol/sdk@1.29.0` 只认到 `2025-11-25`。discover 成功后客户端会在后续请求继续
 * 携带 `2026-07-28`，路由层需要把该请求头归一为 SDK 支持的版本（tools 请求/响应形状在两者间一致）。
 */

export const CLOUD_DRIVE_MCP_SERVER_NAME = "cloud-drive-mcp";
export const CLOUD_DRIVE_MCP_SERVER_VERSION = "1.0.0";
/** 本网关声明的协议版本；只覆盖 tools 能力。 */
export const CLOUD_DRIVE_MCP_PROTOCOL_VERSION = "2026-07-28";
/** SDK 实际实现的协议版本；discover 之后用于请求头归一。 */
export const CLOUD_DRIVE_MCP_SDK_PROTOCOL_VERSION = "2025-11-25";

/**
 * rmcp `DiscoverResult` 形状：`resultType` / `supportedVersions` / `ttlMs` / `cacheScope` 都必填，
 * `serverInfo` 放在 `_meta` 里（与 remove-hermes 的 IM 入口一致）。
 */
export function buildCloudDriveDiscoverResult(): Record<string, unknown> {
  return {
    resultType: "complete",
    supportedVersions: [CLOUD_DRIVE_MCP_PROTOCOL_VERSION],
    capabilities: { tools: {} },
    ttlMs: 0,
    cacheScope: "private",
    _meta: {
      "io.modelcontextprotocol/serverInfo": {
        name: CLOUD_DRIVE_MCP_SERVER_NAME,
        version: CLOUD_DRIVE_MCP_SERVER_VERSION,
      },
    },
  };
}
