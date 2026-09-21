/**
 * bound-mcps.ts — 「当前 Environment 所属 Agent 已绑定的 MCP」联合查询。
 *
 * 这个查询原本写在 `packages/chat-channel/web/components/ChatInterface.tsx` 组件体内
 * （`envApi.get → agentConfigId → agentApi.list → agentApi.get → mcpIds → mcpApi.list 过滤`）。
 * `@fenix/ui-components` 的聊天面板按纯化要求把「绑定 MCP 从哪来」改成宿主注入的 `boundMcps` 端口
 * （见 `web/chat/shell/chat-interface-types.ts` 的 `BoundMcpOption`），查询本身必须落在宿主侧。
 *
 * **为什么落在 `agent-config` 而不是 `agent-runtime`**：这条查询同时需要 Agent 配置（`agentApi`）
 * 与 MCP 资源（`mcpApi`），而 §2.3 依赖矩阵禁止 `agent-runtime` 依赖除 Machine/Sandbox 外的
 * `resources`——该边已在阶段 2 任务 1.4 W4b 通过 `agent-config-lookup-port` /
 * `agent-launch-spec-port` 两个端口消除，不得在此复引（`.dependency-cruiser.cjs` 的
 * `agent-runtime-not-to-resources` 按文件级路径拦截）。`agent-config` 自身同时依赖
 * `@fenix/agent-runtime` 与 `@fenix/resource-mcp`，是本查询唯一合法的归属方。
 *
 * 消费方是宿主容器（`apps/web` 的 ChatArea，它已持有 agentId 并负责把它注入各会话面板），
 * 因此本模块只做查询、不做缓存与节流：并发与失败策略由调用方的 `useRequest` 决定。
 */

import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { mcpApi } from "@fenix/resource-mcp/web";
import type { BoundMcpOption } from "@fenix/ui-components/chat/shell/chat-interface-types";
import { unwrap } from "@fenix/web-runtime/api/request";
import { agentApi } from "../api/agents";
import { getAgentConfigLookupKey } from "./agent-resource-access";

/**
 * 读取指定 Environment 所属 Agent 绑定的 MCP 选项。
 *
 * 返回形状直接满足 ui-components 聊天面板的 `boundMcps` 端口（`id` / `name` / `description`），
 * 用 `summary` 作 `description`——与源组件一致，都是给命令菜单展示的一句话说明。
 *
 * 环境取不到所属 Agent 时返回空数组而不是抛错：`envApi.get` 返回的 `agentConfigId` 为空
 * （ACP/Bridge 环境）属于正常形态，此时该会话本就没有可绑定的 Agent 配置。其余失败
 * （网络、鉴权、Agent 已被删除）按原样抛出，由调用方决定降级方式——本函数不吞错。
 */
export async function loadBoundMcps(agentId: string): Promise<BoundMcpOption[]> {
  const [environment, agentList, mcpList] = await Promise.all([
    unwrap(envApi.get({ id: agentId })),
    unwrap(agentApi.list()),
    unwrap(mcpApi.list()),
  ]);

  const agent = agentList.agents.find((item) => item.id === environment.agentConfigId);
  if (!agent) return [];

  const detail = await unwrap(agentApi.get(getAgentConfigLookupKey(agent)));
  const boundIds = new Set(detail.mcpIds ?? []);
  return mcpList.servers
    .filter((server) => boundIds.has(server.id))
    .map((server) => ({ id: server.id, name: server.name, description: server.summary }));
}
