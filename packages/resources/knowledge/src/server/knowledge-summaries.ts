/**
 * `@fenix/resource-knowledge/server/summaries` 出口的唯一内容：知识库 id 的**展示投影**。
 *
 * 消费方是 `@fenix/resource-agent-config` 的 `services/agent-related-resources.ts`：它持有
 * `agent_knowledge_binding` 给出的知识库 id 集合，用这里的 {@link findKnowledgeBaseSummariesByIds}
 * 换成 `{ name, slug }` 渲染列表。这**不是**知识库资源本体——资源行的授权读写走本包路由与
 * Facade——因此单独出口，避免消费方为了取两个展示字段导入整个服务端 barrel（barrel 会连带把 HTTP
 * 路由、上传解析与 RAGFlow provider 拉进消费方的依赖图）。
 *
 * 出口名与 `@fenix/resource-mcp/server/config`、`@fenix/resource-skill/server/config` 这一对刻意
 * **不同名**：那两条的 `config` 是它们的历史文件名（`server-config.ts` / 服务端配置面），而本包已有
 * `src/server/config.ts`（模块配置，`KnowledgeModuleConfig`，未导出）。沿用 `./server/config` 会让
 * 「键叫 config、内容是标签」的歧义落到本包配置上，而键名是公开契约、事后改名要动消费方——因此首版
 * 就按内容命名。文件放在 `src/server/` 之下、实现留在 `repositories/knowledge-base.ts`（与 mcp 的
 * `services/mcp-labels.ts` 同形：薄文件只做转出，不承载查询）。
 */

export { findKnowledgeBaseSummariesByIds, type KnowledgeBaseSummary } from "./repositories/knowledge-base";
