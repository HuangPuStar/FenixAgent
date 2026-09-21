/**
 * `@fenix/resource-mcp/server/config` 出口的唯一内容：关联 id 的**展示标签投影**。
 *
 * 消费方是 `@fenix/resource-agent-config` 的 `services/agent-related-resources.ts`：它持有
 * `agent_config_mcp` 给出的 MCP id 集合（该关联表随 Agent 配置聚合归 agent-config，任务 1.7 B7），
 * 用这里的 {@link findMcpServerLabelsByIds} 换成名称渲染列表。这**不是** MCP 资源本体——资源行的
 * 授权读写走组合根与 Facade——因此单独出口，避免消费方为了取标签导入整个服务端 barrel（barrel 会
 * 连带把 HTTP 路由与 tool 探测逻辑拉进消费方的依赖图）。
 *
 * 出口名「`./server/config`」刻意不变：它与 `@fenix/resource-skill/server/config` 是同形的
 * 一对，改路径会同时改动两个包的公开契约，收益只有命名。文件位置则随内容改变——B7 之前这里是
 * 「Agent 配置取数面」（含 `agent_config_mcp` 的读写，那时该表归本包），表随 `agent_config` 迁出后
 * 只剩投影，因此从 `services/config/` 移到 `services/`：`config/` 目录现在只放本模块的配置。
 * `agent_config_mcp` 的读写口径于是只有一个 owner（`@fenix/agent-config/db` 与该包 `repositories/`），
 * 本包不再反向导入 agent-config，`mcp ↔ agent-config` 环因此不存在。
 */
export { findMcpServerLabelsByIds } from "../repositories/mcp-server";
