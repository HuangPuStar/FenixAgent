/**
 * Skill 的配置绑定入口。
 *
 * 只包含 Agent ↔ Skill 的关联表访问：它不属于 Skill 资源本体（资源行的授权读写走组合根与 Facade），
 * 而是 Agent 配置侧的绑定关系，因此单独出口，避免宿主为了绑定表导入整个服务端 barrel。
 */
export * from "./server/services/config/agent-config-skill";
