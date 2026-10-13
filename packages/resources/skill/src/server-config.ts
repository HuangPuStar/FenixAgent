/**
 * `@fenix/resource-skill/server/config` 出口：关联 id 的**展示标签投影**。
 *
 * 消费方是 `@fenix/resource-agent-config` 的 `services/agent-related-resources.ts`：它持有
 * `agent_config_skill` 给出的 skill id 集合（该关联表随 Agent 配置聚合归 agent-config，任务 1.7
 * B7），用 {@link findSkillLabelsByIds} 换成名称渲染列表。标签投影不是 Skill 资源本体——资源行的
 * 授权读写走组合根与 Facade——因此单独出口，避免消费方为了取标签导入整个服务端 barrel（barrel 会
 * 连带把 HTTP 路由与下载令牌拉进消费方的依赖图）。形状与 mcp 的 `@fenix/resource-mcp/server/config`
 * 一致。
 *
 * B5 前这里还含 `agent_config_skill` 的读写（那时该表归本包），B7 随表迁出到 agent-config，本包不再反
 * 向导入它，`skill ↔ agent-config` 环因此不存在。
 */

export { findSkillLabelsByIds } from "./server/repositories/skill";
