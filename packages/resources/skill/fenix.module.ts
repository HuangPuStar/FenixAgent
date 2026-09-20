import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Skill 资源模块描述符。
 *
 * Skill 资源（`skill` 表行 + SKILL.md 文档 + 同级归档文件）的资源归属语义、授权编排与「内容 + 资源行」
 * 补偿写入的唯一 owner。装配面上的消费者是宿主 `apps/server`（组合根装配后挂载 `/web/config/skills`、
 * `/api/skills` 与 `/skills/:name/download`，并经 `installSkillServerModule` 注入装配结果）、
 * `@fenix/resource-agent-config`（绑定表读写、元 Agent 的 Skill 装载）与 `@fenix/agent-runtime`
 * （launch spec 取归档路径）。`./server` 出口含资源注册、组合根与 HTTP 路由；只要装配结果或内容能力的
 * 调用方走窄出口 `./server/runtime`、`./server/content`、`./server/config`——barrel 会连带导出 Elysia
 * 路由与下载令牌，把调用方拉进宿主依赖图（理由见 `src/server/runtime.ts` 与 `src/server-content.ts`
 * 的文件头注释）。
 *
 * `dependsOn: []` 是 `src/**`（不含 `__tests__`）值导入的实测结论：本包的全部跨包值导入只有
 * `@fenix/platform-sdk`（`AccessControlModule` / `AuthorizedResourceQuery` / `IdentityDirectory`
 * 等窄契约与错误分类法，见 `src/server/module.ts`、`src/server/facades/skill-facade.ts`、
 * `src/server/repositories/skill.ts`）与 `@fenix/logger`（`createLogger` 等），两者都不是可装配的
 * `resource` 模块，不构成装配边。授权与身份实现由宿主经 `createSkillServerModule(deps)` 注入，
 * 本包不 import 任何平台实现，也不 import 兄弟资源包，因此 skill 是叶子模块。
 *
 * 不声明别的反向边：`@fenix/resource-agent-config`（其 `src/server/services/agent-associations.ts` 的
 * `listAgentSkillIds` / `syncAgentSkills`、`src/server/services/skill-directory.ts`、
 * `src/services/meta-agent.ts`）、`@fenix/agent-runtime`（其 `src/services/launch-spec-builder.ts`）
 * 与宿主都导入本包的服务端入口，方向是它们 → 本模块。把这条边写进本模块会反转装配方向并构成装配
 * 循环：skill 与 agent-config 一旦成套启用，`platform-sdk` 的 `visit()` 会以「模块装配依赖存在循环」
 * 失败；即使抛开循环，本包 `package.json` 也没有这些编译依赖，生成器的 `assertDependsOnDeclared` 会
 * 先行报错。依赖本模块的模块各自声明 skill 才是正确形状。
 *
 * 不声明 `create`：模块组合根（registry 驱动的进程级工厂）属任务 1.3 W2 切片；当前装配由宿主启动
 * 流程调用 `createSkillServerModule(deps)`，再经 `src/server/runtime.ts` 的 `installSkillServerModule`
 * 装入进程单例。不声明 `contributions` / `web` / `envDefinitions`：消费方分别是 §1.5 宿主挂载、
 * §1.6 WebShell 装配与 §1.7 的宿主 env 登记，且本包尚无 `web/index.ts` 浏览器出口（归 W2 切片），
 * 形状必须与消费端同时定型。
 */
export const moduleManifest = {
  id: "skill",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.skill"],
} satisfies ModuleManifest;
