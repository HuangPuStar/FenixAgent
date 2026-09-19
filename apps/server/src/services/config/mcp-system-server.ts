// 经 `./server/runtime` 而非包 barrel 导入：barrel 连带导出 HTTP 路由，会把 agent-runtime 拉进宿主
// 服务模块的依赖图并形成环；这里只需要装配结果与配置类型。
import { getMcpServerModule, type McpServerConfig } from "@fenix/resource-mcp/server/runtime";

/**
 * 系统托管 MCP 服务器的幂等写入。
 *
 * 这是宿主对系统初始化路径的唯一出口：`Hindsight` 等托管服务器由系统按固定名称写入当前用户的
 * 组织，没有对应的用户请求，因此没有可校验的 `resourceId` 与 `actor`。走 Facade 会被授权拦下
 * （成员无 `create` 动作），因此直接调用资源包的领域服务，权限责任在调用方——只允许系统初始化
 * 流程使用，禁止从路由或用户请求路径调用。
 *
 * 幂等语义由仓储的 `onConflictDoUpdate` 保证，且只更新连接配置，不改归属列与 `visibility`。
 */
export async function upsertSystemMcpServer(input: {
  name: string;
  type: string;
  config: McpServerConfig;
  organizationId: string;
  ownerUserId: string;
}): Promise<string> {
  return getMcpServerModule().service.upsertSystemServer(input);
}
