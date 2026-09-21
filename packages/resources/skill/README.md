# @fenix/resource-skill

Skill 资源（`skill` 表行 + SKILL.md 文档 + 同级归档文件）与 Agent ↔ Skill 绑定表（`agent_config_skill`）的唯一 owner；`fenix.module.ts` 声明 `capabilities: ["resource.skill"]`。

## 定位与 owner

- **资源本体**：`src/server/access/skill-resource.ts` 注册 `SKILL_RESOURCE_TYPE = "skill"`——归属列在主表（`organization_id` / `user_id` / `visibility`），创建期归属由 `AccessControlModule.resolveInitialScope` 解析后与 INSERT 同批写入，不需要 side-table。member 默认只有 `read` / `use`，创建、修改、删除与公开受众设置归 owner / admin，`public` 只放大读范围。
- **装配角色**：`resources` 类别、`dependsOn: []` 的叶子模块——本包不 import 兄弟资源包与平台实现，授权与身份实现由宿主经 `createSkillServerModule(deps)` 注入；依赖本包的模块各自声明 skill。`fenix.module.ts` 的 `create` 惰性指向 `src/module.ts` 的 `createSkillModule()`。
- **应用编排**：`SkillFacade`（`src/server/facades/skill-facade.ts`）是用户请求路径的唯一应用入口（route → Facade → `SkillService` → repository）：授权判断、`ResourceAccessDeniedError` → 403 映射，以及「文件系统内容 + 资源行」两次写入的补偿顺序。`SkillService` 只承载领域规则、不接收 actor。
- **系统托管路径**：`SkillSystemApi`（`src/server/services/skill-system.ts`）显式绕过授权谓词（builtin 同步、孤儿清理、公开受众设置），方法名与仓储的 `*Unscoped` 前缀一致，调用点在评审中一眼可见；它复用同一套文档写入，因此系统路径与用户路径遵循同一条「文件与行不许各说一套」的不变量。

## 服务端交付物

- **HTTP（`@fenix/resource-skill/server`）**
  - `createApiSkillsRoutes(deps)` → `/api/skills`（对外已发布合同，`resourceAccess` 视图的唯一保留处）。
  - `createWebSkillsConfigRoutes(deps)` → `/web/config/skills`（控制台）。
  - `skillDownloadRoutes` → `/skills/:name/download`（凭令牌自授权，无 session，故不注入守卫）。
  - 两条带认证的路由都是**工厂**，守卫由宿主注入（`SkillRouteDependencies.authGuardPlugin`），包内不导入 `@server/plugins/auth`。理由：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；两份同名实例会被按 plugin `name` 去重，先构造的一方静默生效。
- **组合根**：`createSkillServerModule(deps)`（`src/server/module.ts`，注入 `accessControl` / `scopeStore` / `authorizedQuery` / `identity`）经 `src/server/runtime.ts` 的 `installSkillServerModule` 装入进程单例。`src/module.ts` 的 `createSkillModule()` 给 registry 补 `id` 并转出 install / get / reset 三个生命周期入口，不复制构造逻辑。未装配即抛错，不静默退化。
- **数据访问**：`src/server/repositories/**` 是包内唯一直接拼 SQL、唯一持有 DB 句柄的位置——`skill.ts`（受控读取经 `AuthorizedResourceQuery` 端口 + 写路径）、`agent-config-skill.ts`（绑定表读写）、启动迁移用的 `listAllSkillOrgAndNameUnscoped()`；service 与 route 不再各自持句柄。受控读取只交出主表、归属列与业务条件，授权谓词、排序与分页由平台实现编译进同一条 SQL。
- **配置**：`SkillModuleConfig { skillDir, baseUrl, downloadTokenSigningKeys }` 经 `getModuleConfig("skill")` 读取并 `strictObject` 校验；校验失败只报字段路径与错误码，不回显字段值（含签名密钥）。签名密钥取首个非空项，与宿主 `RCS_API_KEYS` 的既有语义一致，默认 300 秒有效。
- **测试入口（`@fenix/resource-skill/server/testing`）**：Facade / Service / System / ServerModule 替身、身份目录替身，以及 `createSkillModuleConfig` / `initializeSkillModuleConfig`（宿主测试与本包用例共用同一份「必填字段 + 缺省值」）。包内用例的守卫替身在 `src/__tests__/guard-stubs.ts`。
- **内容层**：`skill-content.ts`（SKILL.md 编排、备份写入与回滚）、`skill-fs.ts`（frontmatter 解析、目录扫描、归档读写）、`skill-download-token.ts`（HMAC 令牌签发与校验）。

## web 面与 i18n

- **浏览器出口**：`./web` → `web/index.ts`，导出 `AgentSkillsPage`、`skillConfigApi`、i18n 的 `SKILL_NS` / `skillResources`、`lib/skill-resource-access` 与 `lib/skill-upload` 的纯函数与类型；`./web/i18n` 单独出口（宿主 i18n 在应用启动期求值，从主入口取会把整棵页面图拉进首屏 bundle）。
- **别名清零**：`web/**` 内 `@/…` 宿主别名与越出到 `apps/web/src/**` 的相对路径各 0 处；跨包引用改为 `@fenix/ui-components/*` 与 `@fenix/web-runtime/*`（组织与会话取值走 §1.6 T7 的 `contexts/org-session` 契约，不再直接依赖 `@fenix/identity/web`）。
- **页面状态口径（§1.3(6)）**：`AgentSkillsPage` 覆盖 loading（骨架带 `aria-busy`）/ empty / error + retry / 无权限 / 写入成功反馈五类状态。无权限是**独立分支**：401（`UNAUTHORIZED`：`runWebHandler` 在缺组织上下文时直接给出）与 403（`FORBIDDEN`：Facade 把平台 `ResourceAccessDeniedError` 映射为 `ForbiddenError`，路由据错误码定状态码）走同一条整页接管，刻意**不给重试按钮**——授权失败是稳定结论，重试只会重复被拒，要做的是重新登录或找管理员；写入成功反馈指创建 / 更新 / 删除三条路径各自的 `toast.success`（否则用户只能从「对话框关了」或「列表少一条」推断结果）。`web/__tests__/agent-skills-page-states.test.tsx` 用真实渲染钉住分支顺序与 `useRequest` 的刷新接线。**该用例的替身边界**：Radix 弹窗内容在 happy-dom 下不挂载（实测 portal 容器建立、内容为空），故以同签名替身替换 `ConfirmDialog` / `FormDialog` 来驱动「确认删除 / 提交表单」两条数据流——被去掉的只是弹窗自身的呈现，`toast` 与列表刷新仍走页面真实逻辑；弹出层自身的渲染归 §1.6 WebShell 的宿主用例。
- **浏览器面守卫**：`web/__tests__/skill-browser-surface.test.ts` 静态走值导入图（递归进 `exports`）：白名单只含浏览器安全的第三方依赖，workspace 包一律不放行，`node:` / `@server/` / 宿主别名 / 包内 `src/` 引用一出现即失败；同时断言入口导出面覆盖消费方所需符号（含 `./web` 与 `./web/i18n` 的导出契约）。
- **i18n 自持**：`web/i18n/namespace.ts` 的 `SKILL_NS = "skills"` 与 `web/i18n/index.ts` 的 `skillResources = { en, zh }` 是本包文案的 owner 入口。宿主 `apps/web/src/i18n/index.ts:22` 经包出口 `@fenix/resource-skill/web/i18n` 取这两个符号（`:117` / `:131` 分别注册 en / zh），**不再**按深相对路径 import 包内 JSON：JSON 路径 `web/i18n/locales/<lng>/skills.json` 从此只是本包的内部布局，宿主只受 `./web/i18n` 的导出契约约束。en / zh 各 98 键（含本轮补齐的 `accessDenied.title` / `accessDenied.description`）、键集完全一致，`web/__tests__/skill-i18n.test.ts` 逐键比对；宿主 `apps/web/src/i18n/locales/` 下没有 skills.json，因此没有需要删除的宿主文案组。

## 边界残留

- **`@server/*` 只剩表定义**：3 处 / 3 文件（`access/skill-resource.ts`、`repositories/skill.ts`、`repositories/agent-config-skill.ts`）引用 `@server/db/schema`，迁出归 §1.7。`@server/db`、`@server/config`、`@server/plugins/auth`、`@server/services/org-context`、`@server/test-utils/*` 已全部切断，包内 `process.env` 读 0 处。
- **`resource → platform-impl` 已消除（§1.6 T7）**：本包 web 面原经 `@fenix/identity/web` 取 `useOrg`（`AgentSkillsPage.tsx` 1 处 / 1 文件），命中架构门禁 `special-dependency`（§2.3 禁止 resource → platform-impl）。现改为 `@fenix/web-runtime/contexts/org-session` 的 `useOrgSession()`：契约落在平台中立的 web-runtime，**实现方仍是身份包的 `OrgProvider`**（它包一层 `OrgSessionProvider`），因此包内拿到的依旧是宿主挂载的同一份 context 实例（§6.5 的同实例约束不变），同时不再依赖任何具体平台实现。本波次 skill / mcp / knowledge / model-management / agent-config 同形，覆盖 `special-dependency → @fenix/identity` 台账的全部 5 条。
- **宿主装配已接线**：`apps/server/src/main.ts:106-112` 从 `@fenix/resource-skill/server` 取 `createApiSkillsRoutes` / `createSkillServerModule` / `installSkillServerModule` / `skillDownloadRoutes` / `skillResource`，`:196-200` 在 `moduleConfigs` 里给出 `skill` 键，`:310` 调 `installSkillServerModule(createSkillServerModule(moduleDeps))`，`:493` 挂 `skillDownloadRoutes`（凭令牌自授权，无守卫），`:499` 挂 `createApiSkillsRoutes({ authGuardPlugin })`；`apps/server/src/routes/web/config/index.ts:6` / `:22` / `:31` 取 `createWebSkillsConfigRoutes({ authGuardPlugin })` 并 `use`。宿主不再引用 `apiSkillsRoutes` / `webSkillsConfigRoutes` 这两个已删除的默认导出，工厂注入守卫的接线已闭环。
- **架构例外台账已按实测收敛**：`web-package-not-to-app @fenix/resource-skill → @fenix/web-app` 这条已随包内宿主别名清零一并删除（现不在 `scripts/architecture/exceptions.json` 中）；`apps-boundary @fenix/resource-skill → @fenix/server-app` 保留，`owner` 由 1.5 调整为 1.7，`rationale` 已改写为「实测 3 处导入 / 3 个文件，全部为 `@server/db/schema` 表定义」；`special-dependency @fenix/resource-skill → @fenix/identity` 已在 §1.6 T7 随 org/session 契约切换删除（见上一条）。
- **命名提示**：`src/server/config.ts`（模块配置）与包导出面 `@fenix/resource-skill/server/config`（`src/server-config.ts`，Agent ↔ Skill 绑定表出口）同名但不是一回事。

## 已知项

- **鉴权本身无包内覆盖**：守卫改注入后包内只能注入替身（放行），`guard-stubs.ts` 只证明路由构造与协议映射正确，不证明鉴权生效。「无凭据 → 401」「已认证但缺组织上下文 → 401」「跨组织资源不可见」的宿主装配用例归 §1.5，缺口已登记 sharedPatches。
- **宿主 config 用例迁出后无覆盖（两条，需补）**：`src/__tests__/skill-dir-config.test.ts` 原含四条宿主断言，随 `@server/config` 切断一并删除（测的是宿主 config 模块，不属于本包职责）。`SKILL_DIR` 绝对路径原样暴露、相对路径按 cwd 解析这两条的解析实现留在宿主 `apps/server/src/config.ts:11`（`skillDir: resolve(env.SKILL_DIR ?? "./data/skills")`），但宿主当前无用例断言 `config.skillDir`——`config-integration.test.ts` 只用 `setConfig` 直注技能目录、不覆盖 env 解析，承接用例需在宿主补；`modelGatewayPublicBaseUrl` 回退到 `modelGatewayBaseUrl`、以及两者独立配置这两条，宿主测试全无命中（`apps/server/src/__tests__/` 下无 `RCS_MODEL_GATEWAY_*` 引用），是当前没有任何宿主用例的可追踪缺口。
- **未声明 `contributions` / `web` manifest 字段**：形状须与 §1.5 宿主挂载、§1.6 WebShell 装配同时定稿；本包已有 `web/index.ts` 浏览器出口，`web` 贡献待 §1.6。
- **`envDefinitions` 未声明，模块配置已由宿主注入**：模块配置字段的声明、校验与 preflight 收敛归 §1.7。宿主已在 `apps/server/src/main.ts:196-200` 的 `moduleConfigs` 里给出 `skill` 键（`skillDir` 取 `config.skillDir`、`baseUrl` 取 `getBaseUrl()`、`downloadTokenSigningKeys` 取 `RCS_API_KEYS` 的逗号分隔列表），并在 `:310` 用同一批 `moduleDeps` 装配模块，因此 `/api/skills`、`/web/config/skills` 与下载令牌三条读取路径都有配置可用，不存在「首次读取即因字段缺失抛错」的路径。
- **表定义迁出后无需改句柄类型**：`SkillDatabase` 刻意不写 `typeof schema`，只做 `select` / `insert` / `update` / `delete`，不使用 `db.query.*` 关系查询。
- **宿主页面与别名的 owner 切换归 §1.6**：`apps/web/src/routes/agent/_panel/skills.tsx`、`apps/web/src/components/PermissionTab.tsx`、`apps/web/src/__tests__/agent-form-dialog-pure-logic.test.ts` 当前经 vite alias 指向包内文件，切换后即为 `@fenix/resource-skill/web`。
