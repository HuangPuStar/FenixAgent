# @fenix/resource-skill

Skill 资源行（`skill` 表）、SKILL.md 文档与同级归档文件的唯一 owner。

## 职责

- **资源行与授权**：`src/server/access/skill-resource.ts` 注册 `SKILL_RESOURCE_TYPE = "skill"`——归属列在主表（`organization_id` / `user_id` / `visibility`），因此创建期归属由 `AccessControlModule.resolveInitialScope` 解析后与 INSERT 同批写入，不需要 side-table。member 默认只有 `read` / `use`，创建、修改、删除与公开受众设置归 owner / admin，`public` 只放大读范围。
- **应用编排**：`SkillFacade`（`src/server/facades/skill-facade.ts`）是用户请求路径的唯一应用入口（route → Facade → `SkillService` → repository）：授权判断、`ResourceAccessDeniedError` → 403 映射，以及「文件系统内容 + 资源行」两次写入的补偿顺序。`SkillService`（`src/server/services/skill-service.ts`）只承载领域规则、不接收 actor。
- **系统托管路径**：`SkillSystemApi`（`src/server/services/skill-system.ts`）显式绕过授权谓词（builtin 同步、孤儿清理、公开受众设置），接口名与仓储的 `*Unscoped` 前缀一致，调用点在评审中一眼可见；它复用同一套文档写入，因此系统路径与用户路径遵循同一条「文件与行不许各说一套」的不变量。
- **内容与归档**：`skill-content.ts`（SKILL.md 编排、备份写入与回滚）、`skill-fs.ts`（frontmatter 解析、目录扫描、归档读写）、`skill-download-token.ts`（HMAC 令牌，密钥取自 `RCS_API_KEYS`，默认 300 秒有效）。
- **HTTP 交付物**：`/web/config/skills`（`src/server/routes/web/config/skills.ts`）、`/api/skills`（`src/server/routes/api/skills.ts`）与 `/skills/:name/download`（`src/server/routes/skills.ts`）；Agent ↔ Skill 绑定表（`agent_config_skill`）走独立出口 `./server/config`，不属于资源本体。
- **装配**：`createSkillServerModule(deps)`（`src/server/module.ts`）由宿主注入 `accessControl` / `scopeStore` / `authorizedQuery` / `identity`，结果经 `src/server/runtime.ts` 的 `installSkillServerModule` 装入进程单例；未装配直接报错，不静默退化。
- **前端**：`web/pages/agent-panel/pages/AgentSkillsPage.tsx` 与 catalog / dialogs 组件；`web/lib/skill-upload.ts`（目录解析与 multipart 清单）与 `web/lib/skill-resource-access.ts`（按 `scope` + `access.actions` 判断，缺失时保守降级为不可读写）是纯逻辑，由 `web/__tests__/` 直接驱动。

## 依赖边界

- 本包属 `resources` 类别，`dependsOn: []`——`src/**`（不含 `__tests__`）的跨包值导入实测只有 `@fenix/platform-sdk`（`AccessControlModule` / `IdentityDirectory` / `AuthorizedResourceQuery` 等窄契约与错误分类法）与 `@fenix/logger`，两者都不是可装配的 `resource` 模块；本包不 import 兄弟资源包，也不 import `@fenix/access-control` / `@fenix/identity` 的实现。
- 反方向由对方声明：`@fenix/resource-agent-config`（绑定表、`skill-directory.ts`、`meta-agent.ts`）、`@fenix/agent-runtime`（launch spec 取归档路径）与宿主 `apps/server` 都导入本包服务端入口；这些边写进本模块会反转装配方向并成环，逐条证据见 `fenix.module.ts`。
- 跨包只经公开子路径（`@fenix/resource-skill/server*`），不引用本包 `src/**`；`apps/server` 是唯一合法装配者（装配组合根、挂路由、注入单例）。

## 守卫由宿主注入

**目标形状，当前尚未成立**。两条路由仍是直接构造的 Elysia 实例（`export default app`）并在文件内 `.use(authGuardPlugin)`（`@server/plugins/auth`）：`src/server/routes/api/skills.ts`、`src/server/routes/web/config/skills.ts`；`src/server/routes/skills.ts` 是下载端点，凭令牌校验（`verifySkillDownloadToken`）而不挂守卫。

Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；守卫又必须与宿主的认证解析（含 `setTestAuth` 测试 seam 与组织上下文）是同一份实例——两份同名实例会被按 plugin `name` 去重，先构造的一方静默生效。因此目标形状与黄金样本 `@fenix/resource-sandbox` 一致：路由以**工厂**导出、守卫由宿主注入，`@server/plugins/auth` 导入清零；改造归任务 1.3 W2 切片。

装配故障不靠守卫兜底：`getSkillServerModule()` 未装配即抛错，避免把装配故障伪装成「资源不存在」。`./server/testing` 提供 Facade / Service / System / ServerModule 替身，未打桩的方法调用即抛错；但包内仍有 7 个测试文件 import 宿主路径（`setTestAuth` / `setTestOrgContext` / `@server/test-utils/stubs/module-stubs` / `@server/config`），改包内 `guard-stubs.ts` 与平台替身归 W2。

## 配置与 DB

- 受控读取一律经 `AuthorizedResourceQuery` 端口（`src/server/repositories/skill.ts`）：仓储只交出主表、归属列与业务条件，授权谓词、排序与分页由平台实现编译进同一条 SQL，仓储不解释 `ResourceQueryConstraint`；写路径不经授权谓词，权限校验发生在 Facade。`src/server/repositories/**` 是唯一数据访问点。
- 句柄在调用时取、不在模块作用域取：`config.skillDir` 在 `skill-content.ts` 内读取（`@server/config`，路径解析的唯一读取处），`@server/db` 句柄在仓储函数内取。
- 内容与行是两种介质：SKILL.md 与归档在文件系统、元数据在 `skill` 表，因此每个写路径都必须给出补偿顺序（见 Facade 的 `create` / `update`）；归档重建只在 `skill-fs.ts` 内进行，不感知表结构。

## 边界外的已知项

- **没有 `web/index.ts`**：`exports` 未声明 `./web`，浏览器入口 `src/index.ts` 是空壳（`export {}`），页面与纯逻辑只能由宿主用别名指向 `web/**`。正确形状是 `./web → ./web/index.ts`；归 W2 切片。
- **路由非工厂形态**：见上节，`@server/plugins/auth` 生产残留 2 个文件；另有 7 个测试文件仍 import 宿主路径。归 W2 切片，宿主侧接线归 §1.5。
- **没有 `src/module.ts`**：registry 驱动的模块工厂入口缺席，组合根是 `src/server/module.ts` 的 `createSkillServerModule` + `src/server/runtime.ts` 的手工单例；归 W2 切片。
- **表定义仍导入 `@server/db/schema`**：生产代码共 8 个文件 / 11 处 `@server/*` 导入（表定义、`@server/db`、`@server/config`、`@server/plugins/auth`）；表定义迁出归 §1.7，其余切断归 W2。
- **env 未收敛**：`src/server/services/skill-download-token.ts` 仍直读 `process.env.RCS_API_KEYS`；`envDefinitions` 未声明，宿主登记归 §1.7。
- **web 侧宿主别名与相对逃逸**：29 处 / 7 文件（`@/src/**`、`@/components/**`，以及 `web/api/skills.ts`、`web/lib/skill-upload.ts` 相对越出到 `apps/web/src/**`）；归 §1.6。i18n 目前只有 `web/i18n/locales/{zh,en}/skills.json`，缺 `namespace` 与 `index.ts`，同归 §1.6。
- **未声明 `contributions` / `web` manifest 字段**：形状须与 §1.5 宿主挂载、§1.6 WebShell 装配同时定稿。
