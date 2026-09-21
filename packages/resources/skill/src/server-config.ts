/**
 * `@fenix/resource-agent-config` 的 Skill 取数面。
 *
 * 两条内容：Agent ↔ Skill 关联表的数据访问（关联表本包声明并管理，读写口径由本包提供，避免第二个包
 * 再写一份 delete + insert 覆盖逻辑），以及关联 id 的**展示标签投影**（再导出 `repositories/skill` 的
 * `findSkillLabelsByIds`，消费方拿绑定表给出的 ID 集合换名称渲染列表）。两者都不是 Skill 资源本体
 * ——资源行的授权读写走组合根与 Facade——因此单独出口，避免消费方为了这两件事导入整个服务端 barrel
 * （barrel 会连带把 HTTP 路由与下载令牌拉进消费方的依赖图）。形状与 mcp 的
 * `@fenix/resource-mcp/server/config` 一致。
 */

export { findSkillLabelsByIds } from "./server/repositories/skill";
export * from "./server/services/config/agent-config-skill";
