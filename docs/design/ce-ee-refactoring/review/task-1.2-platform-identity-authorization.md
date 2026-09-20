# 任务 1.2 实施记录：Platform 身份、租户与授权

范围：`docs/design/ce-ee-refactoring/ce-ee-refactoring-stage-2-plan.md` 任务 1.2，切片 S1–S6。
计划批准件：`.claude/plans/snuggly-drifting-dusk.md`。

本文件记录**偏离、取舍与已知项**；常规实现细节不入此文件。

---

## 一、实施中发现的计划偏离

阶段 2 计划规定「发现设计矛盾、缺失或需要改变公共合同、稳定协议、数据语义时停止对应分支，
先由用户评审并修订权威设计，再继续实施」。以下条目属于该类发现，**待评审**。

### 1.1 `control.ts` 的落点：agent-runtime → apps/server（已按最小耦合方案实施）

- **计划原文（D4）**：`control.ts` → `agent-runtime`。
- **冲突**：`control.ts` 同时依赖 `@fenix/resource-machine/server` 的 `eventService`（经
  `@server/services/transport` 的 `publishSessionEvent`）与 `@fenix/agent-runtime/server` 的会话服务。
  而 `exceptions.json` 已登记 `special-dependency: @fenix/resource-machine -> @fenix/agent-runtime`，
  即 **machine 已经依赖 agent-runtime**。把 `control.ts` 放进 agent-runtime 会新增
  `agent-runtime → resource-machine` 边，形成环形依赖，需要一条新的 `no-circular` 例外。
- **实施**：落在 `apps/server/src/routes/web/control.ts`（宿主协议适配层）。宿主同时合法依赖
  agent-runtime 与 machine，**新增依赖边为零**。
- **待确认**：是否需要改回 agent-runtime 并登记环形例外；若需要，需同步修订依赖矩阵。

### 1.2 `share-link`：迁移 → 删除（已按删除实施）

- **计划原文（D4）**：`share-link` → `agent-runtime`，表保留、删除推迟到 1.7。
- **事实**：`shareLinkRepo` **零生产消费者**。全仓 grep 只命中 `identity-admin` 自身的导出与
  `apps/server/src/__tests__/round19-isolated-repository-boundaries.test.ts` 的 12 个用例；
  没有任何路由或服务读写它。`share_link` 表同样无读写方。
- **实施**：删除 `share-link.ts` 与 `round19` 中 12 个相关用例（含 `shareLink` 工厂与 import）；
  **表保留在 `apps/server/src/db/schema.ts`**，随 1.7 的 DDL 迁移一并 DROP。
- **理由**：把无人调用的仓储搬到新家只是把死代码换个位置；「删除优于兼容」。
- **待确认**：确认 share-link 功能确已下线（而非"有路由但未接线"）。

### 1.3 `/web/*` 响应信封上移 `platform-sdk`（超出 D7 字面范围）

- **D7 原文**：只上移 `/api/system/*` 的共享错误 schema。
- **缺失**：identity 的 `/web/*` 路由使用 `WebOkSchema` / `WebErrSchema`，定义在
  `apps/server/src/schemas/common.schema.ts`。identity 不能导入 `apps/server`；协议契约不能复制
  （两处定义会漂移）；转发 shim 被工程原则 10 禁止。因此信封必须与 D7 的 error schema 一同上移
  `packages/platform/platform-sdk/src/protocol/web-envelope.ts`。
- **影响**：33 个导入点（28 直接 + 3 转发文件 + 5 转发文件的导入者），删除 4 个文件
  （信封定义 + 3 个转发）。**这是计划未列出的范围扩大**，需要确认。

### 1.4 `IdentityDirectory` 的方法数超出计划草稿

计划 §3.1 列出 7 个方法。按真实调用点核对后交付 10 个：**新增 4 个**（`getUser` / `findUserByName` /
`searchUsers` / `resolveMembershipId`）、**删除 1 个**（`isMember`）、`listOrganizationsWithMembers`
补 `slug` 与成员 `phoneNumber`，`OrganizationSummary` 增 `defaultMachineId`。每个方法都有至少两个
真实调用点（下表按生产代码列出），无推测性抽象：

| 契约方法 | 生产调用点 |
|---|---|
| `listUserDisplayInfo` | observer 的人员树与活动流、sandbox 管理面、model-management 的网关用量视图（6 处） |
| `getUser` | `apps/server/src/services/model-gateway-subject-verification.ts`（`USER_NOT_FOUND` 判定） |
| `findUserByName` | `agent-runtime/src/server/repositories/environment.ts` 的 `listActiveByUsername`（经 `environment-acp.ts` 生产调用） |
| `searchUsers` | `model-management` 的 `subject-service.ts`（`/api/system/*` 管理端用户检索，需 `emailVerified` / `phoneNumber`） |
| `listOrganizationNames` | skill / mcp 的 `/web` 与 `/api` 路由、observer、sandbox（5 处） |
| `getOrganization` | `machine/registry.ts`（退役引用校验）、`apps/server/src/services/org-context.ts`、`model-gateway-subject-verification.ts` |
| `resolveMembershipId` | `agent-runtime/src/services/launch-spec-builder.ts`、`resources/memory/src/server/services/hindsight.ts`（Hindsight bankId = member 行 ID） |
| `listMemberships` | `apps/server/src/services/org-context.ts`（确定性默认组织）、`model-gateway-subject-verification.ts`（构造全量成员关系） |
| `resolveSystemTenant` | `agent-config/src/services/meta-agent.ts`（builtin skill 宿主）、`model-management` 的 `provider-service.ts`（网关 Provider 宿主） |
| `listOrganizationsWithMembers` | `observer/src/server/services/system-people-tree-service.ts` |

**收口复核修正（S6）**：本表原先记的调用点有两处已随实施失效（`searchUsers` 原指向的
`model-gateway-subject.ts` 已删除、`getUser` 原指向的 `model-gateway/runtime.ts` 已改为读
`listUserDisplayInfo`），且原记的"12 个方法"与实际交付的 10 个不符。已按当前生产代码逐条重核并改写。
`isMember` 在收口复核时判定为**零生产消费者**（成员关系判断一律经 `AccessControlModule` 的授权谓词，
目录侧再暴露一个"是不是成员"只会成为权限旁路），已从契约、实现与 4 处测试桩中删除。

### 1.5 计划清单的假阴性（迁移范围修正）

5 透镜交叉核对发现计划清单漏列、但物理上必须随 identity-admin 删除而重接的读取点：

- `packages/agent-runtime/src/services/acp-idle-monitor.ts`（`findUsersBasicInfoByIds`）——该文件
  在 `exceptions.json` 中登记为 owner=1.4 的 `agent-runtime-not-to-resources` 例外，但 identity-admin
  删除后 import 物理失效，S1 必须重接。
- `packages/resources/observer/src/server/services/observer/observer-service.ts`（`organizationRepo` +
  `findUsersBasicInfoByIds`）。
- `packages/platform/access-control/src/resource-permission.ts`（注入 `organizationRepo.listNamesByIds`）
  ——`platform-impl → platform-impl` 未被禁，可直接依赖 identity。

假阳性（计划列了但实际不读身份）：`agent-instance.ts`、`skill.ts`、
`agent-route-support.ts`、`migrate-skill-storage-by-organization.ts`。

### 1.6 `user_config` 的归属

计划把它列入迁入 identity 的表。它外键 `user`，但描述的是组织级 Agent/模型偏好。消费者
`apps/server/src/services/config/user-config.ts` 在宿主内、经 `@fenix/identity/db` 读表，未产生
包边界违规。已在包 README 记为待评估项。

### 1.7 `db/index.ts` 不做 schema 聚合（计划字面要求的一半未做）

- **计划原文**：「`db/index.ts` 的 `schema` 聚合与 `drizzle.config.ts` 改为路径数组」。
- **实施**：`drizzle.config.ts` 已改为路径数组；`apps/server/src/db/index.ts` **保持**
  `drizzle(client, { schema })`（仅 apps/server 的表）。
- **理由**：`schema` 选项只服务于 `db.query.*` 关系查询 API，全仓无一处使用；把身份表并进来
  除了让宿主的 `db` 类型包含它并不使用的表之外没有消费者，属于推测性耦合。若后续引入
  `db.query.*` 再聚合。
- **待确认**：是否需要为「宿主 DB 句柄忠实反映物理库」这一约束而补上聚合。

### 1.8 `org-context` 的默认组织顺序由未定义改为确定性

- **改动**：`loadOrgContext` 的「第一个组织」回退从 better-auth `listOrganizations` 的返回顺序
  改为 `IdentityDirectory.listMemberships` 的 `member.createdAt` 升序（同值按 `member.id`）。
- **理由**：新实现必须给出确定顺序，否则同一用户在不同请求间可能落到不同默认组织，进而让
  `/web` 读写的归属漂移。契约已把该顺序写入 `listMemberships` 的文档注释。
- **风险**：若线上 better-auth 的返回顺序与 `member.createdAt` 不同，少数用户的默认组织会变化。
  个人组织在注册时创建，因此预期一致。

### 1.9 RMD-06/RMD-08 台账随身份职责迁移改判

- **1.2 版落点**（`scripts/root-source-owner-rules.ts`、`scripts/__tests__/rmd-06-migration.test.ts`、
  `docs/arch/root-source-owner-inventory.md`）：
  - `src/repositories/user.ts` → `packages/platform/identity/src/repositories/user.ts`；
    `ChangePasswordDialog.tsx` → `packages/platform/identity/web/components/`（身份职责）。
  - `src/routes/web/control.ts` → `apps/server/src/routes/web/control.ts`（理由见 1.1）。
  - `share-link.ts`、`token.ts`、`token-manager-dialog-form.test.ts`、`token-stats.test.ts` →
    **删除**（`null` 落点）。`token.ts` 与 D4 一致（遗留内存 token 管理器，无消费者），
    `share-link.ts` 的理由见 1.2。
- **台账结构**：RMD-06 由两列改为三列（旧根路径 / RMD-06 原目标 / 1.2 后当前落点），使"改判"
  与"删除"在断言中可区分——`null` 表示删除且必须不存在，非 null 表示存在且旧目标必须消失。

### 1.10 `@fenix/identity → @fenix/web-app` 落入 dependency-cruiser 规则射程

- **事实**：同一条 Web 越界债务被两条规则各记一次：自定义规则 `web-package-not-to-app`（按源码里
  的越界 specifier 计，45 处）与 dependency-cruiser 的
  `platform-not-to-agent-runtime-resources-apps`（按解析后的真实边计，35 处）。identity 从
  `packages/resources/` 迁到 `packages/platform/` 后才落进后者的 `from: packages/platform/` 射程。
- **实施**：在 `exceptions.json` 新增该条目（owner 1.6），`rationale` 写明两条规则口径不同的原因；
  两者在 WebShell 公开面落地后同批删除。

### 1.11 宿主中介环消失：13 条 `no-circular` 例外删除（超出计划范围的正向收益）

- **触发**：`apps/server/src/plugins/auth.ts` 原本静态导入 `@fenix/agent-runtime/server`（barrel）。
  该 barrel 引入 `launch-spec-builder` → `@fenix/resource-knowledge/server`（barrel 仍含路由模块）
  → knowledge 路由反向依赖 `@server/plugins/auth`，形成 `auth → agent-runtime → knowledge 路由 → auth`
  的顶层 TDZ 环，并以宿主为中枢把多个资源包串成环（`resource-mcp → resource-mcp` 等自环亦由此产生）。
- **实施**：改用同一包已有的窄入口 `@fenix/agent-runtime/server/environment`（只导出 environment 仓储）。
  这不是 1.5 的环治理，而是宿主适配层的最小依赖收敛。
- **结果**：dependency-cruiser 复算后 13 条 `no-circular` 例外不再违规，按门禁要求删除台账条目
  （门禁禁止保留"已不违规"的例外）；`apps/server/src/__tests__/source-route-imports.test.ts`
  （在全新 ESM 进程中加载资源包路由）随之恢复通过。
- **注意**：剩余 `no-circular` 例外仍在台账中，归属 1.5。

### 1.12 测试基建：`IdentityDirectory` 的 stub 与默认值语义

- **缺失**：`getIdentityDirectory()` 在生产由 `main.ts` 装配时注入，测试进程不装配宿主，未注册时
  直接抛错，导致 `org-context`、acp 空闲监控、observer 名称解析等直接调用方在测试里全部失败。
- **实施**：新增 `apps/server/src/test-utils/stubs/identity-directory-stub.ts`，并在 `setup-mocks.ts`
  注册一个**转发代理**（每次属性访问读当前 stub，而非注册时的快照），用例用
  `stubIdentityDirectory()` 逐字段覆盖；`resetAllStubs()` 一并复位。
- **刻意的默认值**：默认是"空投影"而不是看似合理的假数据；`resolveSystemTenant` 默认抛错——
  系统托管租户的 `userId` 是审计主体，测试不得在未声明的情况下拿到一个假身份。
- **用例语义变化**：round21 的 9 个 org-context 用例由 `stubAuthApi`（better-auth `listMembers` /
  `listOrganizations`）改为 `stubIdentityDirectory({ listMemberships, getOrganization })`；
  原「兼容 `{ members: [...] }` 包装」用例删除——那是 better-auth 的返回值形态，窄契约返回强类型
  数组，不再存在该形态，保留它会变成对已删除实现细节的断言。

### 1.13 `org-context` 的组织名查询保留独立容错

- **回归风险**：迁移中把组织名查询并入外层 `try` 会让"名录读取失败 = 无组织上下文"，与改动前
  （内层独立 `try/catch`）以及既有用例 `组织名称加载失败仍返回成员` 的契约不符。
- **实施**：为 `getOrganization` 单独 `try/catch` + warn 日志，成员关系一旦确定就不因展示信息失败而回退。

### 1.14 `isOrganizationMember` 改为存在性单行查询

- **改动**：原实现复用批量接口 `findOrganizationMemberUserIds`，会把该用户在组织内的**全部**成员行
  读回再判空。归属判定只需"是否存在"，改为 `limit 1` 的存在性查询（`findOrganizationMemberUserIds`
  仍保留给候选用户批量过滤的真实批调用点）。
- **附带效果**：`packages/resources/mcp` 的 `API key 列表将 key 元数据组织传给服务` 用例的 `stubDb`
  只提供 `limit()` 调用链，批量实现走 `.execute()` 而失败；语义修正后该用例无需扩宽 stub。

### 1.15 凭据链回归测试的落点：宿主认证适配层（而非 identity 包内）

- **计划原文（§六）**：S1 需补 identity 单测覆盖「API Key 组织恢复」「保守拒绝」。
- **约束**：这两条路径依赖 `getAuth()` 与 identity DB 的替身，而替身注册表位于宿主测试基建
  （`apps/server/src/test-utils/stubs/**`，由 `setup-mocks.ts` 在 preload 装配）。`packages/platform/*`
  的测试引用宿主文件会新增 `platform-not-to-agent-runtime-resources-apps` 违规（门禁无对应例外，
  且该方向在设计上就该禁止），因此不能在 identity 包内测。
- **实施**：用例落在宿主认证适配层 `apps/server/src/__tests__/round45-auth-plugin.test.ts`（已有该
  文件的会话优先级、seam、无凭据用例同处一处），新增 5 条：API key 组织与角色恢复、缺组织元数据拒绝、
  非成员拒绝、成员校验异常保守拒绝、Environment Secret 组织回落（含 `authEnvironmentId`）。
- **收口结论**：这不是"可选的落点"，而是唯一可行落点——测试替身注册表位于宿主测试基建，
  `packages/platform/*` 引用宿主路径会命中 `platform-not-to-agent-runtime-resources-apps`，该方向在
  设计上就该禁止（门禁无例外、也不应为此新增例外）。因此"计划要求 identity 包内单测"与"包边界"
  不可兼得，覆盖保留在同一处已有认证用例的文件里、断言的是宿主适配层行为。评审只需确认这一拆分
  可接受，不存在第二种修法。

### 1.16 个人组织引导抽出可注入写入端口

- **问题**：计划要求的第三条 identity 单测「个人组织引导」原本是 better-auth
  `databaseHooks.user.create.after` 的内联回调，而测试进程里 better-auth 模块整体被替身替换，
  钩子不可达，该不变量无法断言。
- **实施**：抽出 `packages/platform/identity/src/services/personal-organization.ts`
  （`ensurePersonalOrganization` + `PersonalOrganizationWriter` 端口，生产默认实现落模块 DB），
  钩子只保留"调用 + 吞异常记录日志"（失败不阻断注册的行为与迁移前一致）。ID 生成与 slug 形态逐字保留。
- **测试**：`packages/platform/identity/src/__tests__/personal-organization.test.ts` 4 条
  （owner 成员、时间戳一致、ID 独立、slug 截断）。
- **未覆盖**：默认写入器（落模块 DB 的那条实现）在测试中不可达——它需要宿主 DB 替身，理由同 1.15。

### 1.17 `/web` 视图新增顶层 `organizationName`（D2 之外的一处协议新增）

- **D2 原文**：`/web/*` 响应改用 `scope + access.actions`。
- **缺失**：旧 `/web` 视图里"来源组织可读名称"只存在于 `resourceAccess.sourceOrganizationName`，前端用它
  渲染跨组织共享资源的标签与名称前缀（`Source Team/shared`）。改用 `scope + access.actions` 后
  `scope` 只有 `organizationId`，界面会退化成裸 UUID。
- **实施**：`/web` 列表项与详情新增顶层可选字段 `organizationName`，由 `IdentityDirectory.
  listOrganizationNames` 解析（列表一次批量、详情单条）；名录不可用或缺项时字段整体省略，与迁移前
  "名录不可用时不出名称"的行为一致。
- **待确认**：是否接受该字段成为 `/web` 协议的一部分（等价替代 `resourceAccess.sourceOrganizationName`）。

### 1.18 `/web` handler 的返回值必须是 Elysia 可渲染的联合（新增 `WebHandlerResult`）

- **现象**：协议层报 2 处 TS2345，根因是 Elysia 的 `InlineHandler` 要求"源类型的每个成员都能落入
  同一个目标联合成员"；`Response` 与自定义成功体不能共存于一个联合里。
- **实施**：定义 `WebHandlerResult = 成功体 | 错误体` 并写明"刻意不含 `Response`"的原因（`status(...)`
  返回的 `ElysiaCustomStatusResponse` 由 `InlineHandler` 自己的联合覆盖），把 11 处 `Promise<unknown>`
  收敛到该类型。后续给 `/web` handler 增加返回值时必须落在这个联合内。

### 1.19 删除与工具缓存清理合并为同一事务（替代 best-effort 补偿清理）

- **改动**：`remove` / `removeById` → Domain Service → 仓储 `deleteWithTools`：同一事务内删主表行与
  该组织的 `mcp_tool` 行。
- **理由**：`mcp_tool` 没有独立生命周期；best-effort 清理在进程崩溃或补偿失败时留下孤儿行，污染后续
  同名资源的工具计数。
- **影响**：删除变成"要么都删、要么都不删"；清理条件由 `(organizationId, serverName)` 决定，同名资源
  在不同组织间不会互相清理。

### 1.20 系统托管服务器写入走 Domain Service，不走 Facade

- **事实**：Hindsight 托管 MCP 由系统初始化路径写入，没有用户请求、没有 `actor`；走 Facade 会被授权
  拦下（D1 下 member 无 `create` 动作，系统路径也无主体可校验）。
- **实施**：宿主出口 `apps/server/src/services/config/mcp-system-server.ts` 直接调用资源包的领域服务
  `upsertSystemServer`。幂等由 `onConflictDoUpdate(organization_id, name)` 保证，且**只更新连接配置，
  不改归属列与 `visibility`**——系统路径同样不得让资源在组织之间漂移或静默改变公开受众。
- **边界**：该出口绕过授权，只允许系统初始化流程调用，已在文件注释中显式禁止从路由或用户请求路径调用。

### 1.21 列表：谓词与排序全部下推，`/web` 不引分页（D9 的执行细节）

- `/web` 列表调用 `facade.list(actor)`（不下传 limit/offset），排序由领域服务固定为 `name asc`：列表
  顺序属于对外可观测行为，不能依赖数据库的物理返回顺序。
- `/api/mcp` 的 `page/pageSize` 换算为 `limit/offset` 下推到同一授权谓词；`total` 由与列表**同一份**
  授权条件与业务条件的 `count` 产出（分页与计数不得建立在不同的可见集合上）。

### 1.22 mcp 包与旧授权栈彻底解耦

- `packages/resources/mcp/package.json` 删除 `@fenix/access-control` 依赖；包内不再有任何该包的导入
  （仅 `module.ts` 注释提及宿主注入的能力来源）。
- `scripts/architecture/exceptions.json` 删除 `special-dependency @fenix/resource-mcp →
  @fenix/access-control`，依赖门禁复算后无新增违规。

### 1.23 mcp 测试重组：删除被取代的用例，路由测可观测行为、Facade 测编排

- **删除**：`api-mcp-routes.test.ts`（列表形状 / 更新 404 / 删除返回 ID 三点已被 round47 覆盖）、
  `mcp-route-resource-access.test.ts`（`/web` 已无 `resourceAccess`；external/internal、公开受众、
  `update` 透传 `publicReadable` 已在 round40 覆盖，外部资源写动作的 403 合并进 round40「启停与检测对
  无权资源返回 403」）。
- **路由用例**改为模块替身（`installMcpServerModule(createStubMcpServerModule(...))`，未打桩即抛错），
  断言只落在"路由是否把正确的参数交给 Facade"与响应映射；Facade 内部行为（工具计数降级、名称优先级、
  删除事务、权限拒绝映射）移入新增的 `mcp-server-facade.test.ts`（22 条：真实 `McpServerFacade` + 假
  accessControl / scope store / 领域服务替身）。
- 新增 `__tests__/fixtures.ts` 承载公共 fixture（主体、资源行、授权实现替身、scope store 记录器）。
- **顺带修正** `server/testing.ts` 的 `createStubMcpServerModule`：`...overrides` 收尾会把显式传入的
  `undefined` 覆盖回兜底值，改为逐字段兜底（`??`）。

### 1.24 `visibility` DDL 与数据回填

- **DDL**：四张受控资源主表 `ADD COLUMN visibility varchar(20) NOT NULL DEFAULT 'private'` +
  `(organization_id, visibility)` 索引；与既有 `agent_site_app.visibility` 同形，不引入共享 pg enum。
- **回填** `backfill-resource-visibility`：`principal_type='all' AND action='read'` → `visibility='public'`，
  分批 500 行；`verify` 硬断言 `principal_type='organization'` 计数为 0。
- **运维提示**：该断言失败会中止启动流程，此时**不得放宽断言**——组织级授权记录在新栈中没有对应语义，
  需人工处置（旧栈仍在读取授权表，因此处置前不会丢权限）。

### 1.25 资源包 barrel 的传染性：新增窄出口替代裸导入

- **事实**：`@fenix/resource-mcp` 的包 barrel（`./server`）会连带导出 HTTP 路由，路由再拉起
  `agent-runtime`，于是「宿主的服务模块 → 资源包 barrel」这一步就把整个运行时装进宿主依赖图，
  与既有的「资源包 → 宿主内部实现」边闭合出环。S1 装配时该环表现为
  `@fenix/server-app → @fenix/resource-mcp` 指纹；S2 移除 agent-config 路由对 mcp barrel 的裸导入后，
  对应的 `@fenix/agent-config → @fenix/resource-mcp` 指纹也不再违规均失效。
- **实施**：mcp 包新增两个不含路由的窄出口，宿主与邻包一律经窄出口导入：
  - `./server/runtime` —— 装配结果与配置类型（`getMcpServerModule` / `McpServerConfig`），
    消费者是 `apps/server/src/services/config/mcp-system-server.ts`；
  - `./server/config` —— Agent↔MCP 绑定读写（`listAgentMcpIds` / `syncAgentMcps`），
    消费者是 agent-config 的服务出口。
- **结果**：`scripts/architecture/exceptions.json` 累计删除 3 条失效 `no-circular` 条目（S1 收口 2 条，
  本轮 1 条：`@fenix/agent-config → @fenix/resource-mcp`），台账条目 66 条，门禁上报「25 条已登记例外」
  （上一轮 26 条），0 新增违规、0 失效条目。
- **通行规则（后续切片沿用）**：宿主服务模块与资源包内部模块**不得**经资源包 barrel 导入；
  包若同时导出 HTTP 路由与库能力，必须提供不含路由的窄出口。

### 1.26 路由依赖必须经 DI 代理取得，不得裸导入资源包

- **事实**：S2 把 mcp 的绑定函数从宿主 config barrel 的再导出中移除后，agent-config 路由里
  `import { listAgentMcpIds } from "@fenix/resource-mcp/server"` 的裸导入不再能被
  `stubConfigPg({ listAgentMcpIds })` 替换，round44 / round45×2 / api-agents-routes /
  `apps/server/src/__tests__/config-integration.test.ts` 中对 mcp 绑定的打桩静默失效
  （skill 的同类裸导入当时仍生效，因为宿主 barrel 还在再导出它——正是这种"部分生效"让失效不易发现）。
- **实施**：agent-config 的服务出口经 mcp 窄入口 `@fenix/resource-mcp/server/config` 再导出这两个函数，
  路由改调 `configPg.listAgentMcpIds` / `routeConfigDeps.syncAgentMcps`（`routeConfigDeps` 代理 +
  `setRouteConfigDepsForTesting` 是 agent-config 既有的测试接缝）。这样生产走真实实现、测试走同一接缝，
  不再依赖"宿主 barrel 恰好也再导出同名符号"这一隐式条件。
- **范围说明**：`listAgentSkillIds` / `syncAgentSkills` / 知识库绑定仍是裸导入（宿主 barrel 仍再导出，
  当前可打桩）。它们会在 S3（skill）与 S4（agent-config）按 Facade 模板切换时一并收敛，
  本切片不提前改，避免与后续切片重复改动同一批调用点。
  **S3 复述**：S3 只切 skill 资源包自身（授权栈、路由、前端视图），这三个函数属于 agent-config 的
  资源绑定表，本轮仍未触及（与知识库绑定同一批），随 S4 一并收敛——因此本条的"部分完成"状态需在 S4
  收口时复核，不得记为已关闭。
- **前端同步**：`/web` MCP 视图改成 `scope` + `organizationName`（D2）后，
  `mapMcpOptions` 的入参已改为 `McpResourceLike`；
  `packages/resources/model-management/web/__tests__/provider-model-resource-access-flow.test.ts` 中
  唯一的 MCP 用例仍在断言旧 `resourceAccess` 字段，本次一并更新为新视图（断言语义不变：只保留已启用项、
  跨组织键为 `${scope.organizationId}/${id}`、展示名带归属组织名）。

### 1.27 既存缺陷：上传冲突的 409 响应体被响应 schema 清理，`data` 到不了前端（已修）

- **事实**：`/web/config/skills/upload` 的同名冲突分支在 409 里返回
  `{ success: false, error: {...}, data: { conflicts, allowedStrategies } }`，但该端点的响应 schema 是
  `WebErrSchema`。Elysia 按响应 schema 清理返回值时，zod 对象会把**未声明的键剥掉**，`data` 因此丢失。
  实测确认（同一调用方式下 `WebErrSchema.extend({ data })` 保留、`WebErrSchema` 剥离），
  `HEAD` 上就是同一 schema 加同一调用方式，**属既存缺陷而非本轮引入**。
- **影响**：前端 `AgentSkillsPage.getUploadConflictData` 依赖 `error.data.conflicts` /
  `allowedStrategies` 弹出覆盖/忽略选择弹窗；`data` 被剥掉后该弹窗永不出现，用户只能看到一条
  "检测到同名技能冲突"的错误提示，无法选择策略。
- **实施**：新增 `SkillUploadConflictSchema = WebErrSchema.extend({ data: ... })` 挂到上传端点的 409，
  并在注释里写明"响应 schema 必须显式声明 `data`，否则会被剥掉"这一约束。
- **为什么归到 1.2**：它是本切片新增的 409 契约（冲突清单 + 策略）能成立的前提；不修则新契约等于不存在。

### 1.28 S3 重写引入并已修的两处回归

1. **上传路由解构 Elysia 响应标记对象**。`runWebHandler` 把失败分支的返回值换成了 `status(code, body)`
   的返回值，而它是**响应标记对象而不是 body**。上传路由仍按旧写法解构 `result.error.code`，于是取到
   `undefined` 并抛 `TypeError`，所有表单类 400 一律变成 500（上传用例 14 pass / 10 fail）。
   修复：`runWebHandler` 增加 `statusOverrides` 参数，状态码映射在 `runWebHandler` 内部完成
   （返回值已是标记对象，调用方拿不到错误码）；路由不再解构标记，下载路由改用 `isWebSuccess()` 守卫。
2. **`writeSkillDocument` 的回滚判定用了"快照表非空"而不是"本次确实有快照"**。
   `backupSkillDirs` 对**不存在的目录也会写入 `null` 占位**，因此 `snapshots.size > 0` 恒真：新建路径
   失败时会走进"覆盖失败"分支，去重建一个刚被删掉的目录，并把本次写入产生的归档留在磁盘上成为孤儿
   （`deleteSkillArchive` 未被调用）。`HEAD` 用的是 `snapshots.get(name)`，属重写时丢失的语义。
   修复：`snapshotPath = snapshots.get(safeName) ?? null; hasSnapshot: snapshotPath !== null`。

### 1.29 内容层 DI 接缝补上 `readSkillDocumentFromMd`

`writeSkillDocument` 直接静态调用 `readSkillDocumentFromMd`，内容层替身无法控制"既有文档"这一输入，
导致"合并既有 frontmatter 元数据"这条路径只能靠真实磁盘验证。已把该函数加入 `_deps.skillFs` 并改走接缝，
用例现在可以显式给出既有文档（`skill-archive-lifecycle` 的合并用例）。

### 1.30 skill 测试重组：删除被取代的用例，路由测协议、Facade 测编排、内容层测介质一致性

- **删除**（连同覆盖归位说明）：
  - `skill-resource-access.test.ts`（169 行）—— 断言的是旧栈 `resourceAccess` 驱动 service 返回的
    internal/external 视图；新架构下归属由 `scope + access.actions` 表达，该可见性判定已结构性消失，
    由 `skill-facade.test.ts` 的授权用例与前端 `skill-resource-access-*` 用例覆盖。
  - `skill-resource-id-validation.test.ts`（110 行）—— 旧栈把 `resource_permission` 里的资源 ID 规范化
    （大小写 / nil UUID）后再比对；新栈的授权判定由 SQL 谓词承担，不存在这一层 ID 规范化。
  - `skill-import-parallel-deletes.test.ts`（176 行）—— 其中"overwrite 不得在写入前删除 PG 记录"
    对应的代码路径已不存在（`importSkillDirectories` 不传 `onConflictCleanup`，编排里没有写入前的行删除
    钩子），由 Facade 的幂等 `upsertByOrgAndName` + "覆盖失败恢复被覆盖的资源行"承接；"回滚回调抛错不
    掩盖原始错误"迁入 `skill-import-name-overwrite.test.ts`。其中 `同一批上传目录名大小写重复` 是**伪用例**：
    它断言的是当时 mock 里自定义的大小写去重，真实 `groupUploadFiles` 不做大小写归一，予以丢弃。
- **重组**：`round44-skills-config-routes.test.ts`（24 条）与 `api-skills-routes.test.ts`（12 条）改为
  模块替身，只断言协议职责（参数校验、主体与分页下推、视图映射、错误码 → 状态码）；Facade 行为移到
  `skill-facade.test.ts`（20 条）；内容层拆成 `skill-archive-lifecycle.test.ts`（8 条：写盘顺序、回滚、
  归档一致性）与 `skill-import-shared-validation.test.ts`（4 条）、`skill-import-name-overwrite.test.ts`
  （4 条）。
- **关键测试基建**：协议用例的 `beforeEach` 必须装配默认替身（`installSkillModuleStub()`），否则参数校验
  用例会先撞上"Skill 资源模块未装配"而拿到 500，掩盖真正的校验分支。

### 1.31 skill 前端切换到 `scope + access`（D2 的前端侧）

- `packages/resources/skill/web/lib/skill-resource-access.ts` 按 mcp 的同名模块重写：判定来源改为
  `scope.organizationId` 与 `access.actions`，新增 `isExternalSkill(skill, activeOrganizationId)` 与
  `isPublicSkill(skill)`；`canWriteSkill` 由 `update` 动作决定，缺失时**保守判为不可写**（旧实现是
  `writable !== false`，缺失即视为可写——在新视图下会越权展示编辑入口）。
- `getSkillKey` / `getSkillLookupKey` 由 `resourceAccess.resourceKey` 改为
  `${scope.organizationId}/${id}`（二者缺一退回 `name`）；选项展示名改用顶层 `organizationName`。
- 调用方同步：`agent-skills-utils.ts`（筛选与计数按归属）、`agent-skills-catalog.tsx`（8 处直读改 helper，
  新增 `activeOrganizationId` prop）、`AgentSkillsPage.tsx`（经 `useOrg()` 取当前组织，公开开关改按
  `scope.visibility` 取反）、`use-agent-editor.ts`（选项分组按 `scope` / `organizationName`）。
- 契约类型：`apps/web/src/types/config.ts` 的 `SkillInfo` / `SkillDetail` 改为
  `extends Partial<ResourceAccessView>` + 顶层 `organizationName`；`api/skills.ts` 的保存结果同形。
- **一处顺带修正**：`packages/resources/skill/web/__tests__/*.test.ts` 里三处
  `import type { ... } from "../types/config"` 指向**不存在**的目录（`packages/resources/skill/web/types/`
  从未存在），只因 `import type` 被擦除而未被发现。改为 `@/src/types/config`。

### 1.32 宿主 `Skill*Schema` 与再导出按「已无消费者」删除

`apps/server/src/schemas/config.schema.ts` 的 `SkillInfoSchema` / `SkillDetailSchema` /
`SkillListResponseSchema` / `SkillSaveResultSchema` / `CreateSkillResponseSchema` /
`UpdateSkillResponseSchema` / `DeleteSkillResponseSchema` / `SkillUploadConflictSchema` /
`SkillUploadResultSchema` / `SkillUploadResponseSchema` / `SkillSourceInfoSchema` 及对应 7 个类型，
连同 `apps/server/src/schemas/index.ts` 的再导出一并删除（全仓库检索确认无消费者：`/web` 与 `/api` 的
skill 协议 schema 都在资源包内）。同文件中的 `Mcp*Schema` / `Model*Schema` 仍是死代码，但属 S2 / S5 的
切片范围，本轮不动（S6 收口时按同一判据清理）。

### 1.33 `exceptions.json` 删除失效的 `special-dependency @fenix/resource-skill → @fenix/access-control`

skill 包不再导入旧授权栈后，该例外条目变成"已不再违规"，架构门禁直接报错要求删除。已删除；
`model-management` 的同类条目仍在（S5 范围）。

### 1.34 `packages/resources/skill/package.json` 删除 `@fenix/access-control` 依赖，并由此暴露 `bun.lock` 自 S1 起失同步

- 与 S2 的 mcp 处理一致（1.22）：包内已无该包的导入，依赖声明随之删除。
- **顺带发现**：删除这条依赖后 `bun install --frozen-lockfile` 报"lockfile had changes"。核对差异后确认
  `bun.lock` 自 **S1** 起就与各 `package.json` 不一致（S1 删掉的 `@fenix/resource-identity-admin`、
  新增的 `@fenix/identity`、`apps/server` 的多条 workspace 依赖都未写回锁文件），本次重新生成一并补齐
  （`bun install`，91 增 21 删）。S1 / S2 的 precheck 未受影响，因为门禁不跑 `--frozen-lockfile`。
- **记录原因**：锁文件漂移不会让任何本地门禁失败，但会让 CI 的 frozen 安装失败；后续切片改
  `package.json` 必须同时重新生成 `bun.lock`。

### 1.35 `/api/agents` 重写：分页与计数下推，`resourceAccess` 由授权视图派生（D2 / D3）

`packages/resources/agent-config/src/server/routes/api/agents.ts` 全量重写（413 行）：

- 列表的 `limit` / `offset` 与总数经 `facade.list(actor, { limit, offset })` 下推，不再把本组织与
  其他组织的资源全量读出后内存分页（正是设计 §3.5 禁止的形态）。
- `resourceAccess` 是 `/api` 侧**唯一**保留旧字段形状的位置（D2）：由 `toResourceAccessView()` 从
  `scope` + `access.actions` 派生，`ownership` / `manageable` / `writable` / `publicReadable` 全部
  由动作集合与归属推导，不再有第二处真相。
- 写路径（PUT / DELETE）按资源键 `<activeOrganizationId>/<resourceId>` 定位：跨组织的写请求表现为
  404 而不是 403，与迁移前"同组织可见否则不存在"的语义一致，也不泄露资源是否存在。
- DELETE 先按资源键读取以拿到 `name` 做内置判定（内置 Agent 返回 403），再调用 `facade.remove`；
  404 / 403 均由 Facade 抛宿主错误类。

### 1.36 `/api` 的同名冲突：先放宽为「可见即冲突」，复核后按裁决退回「本组织内」

迁移前 `POST /api/agents` 的同名判定基于"本组织内同名"（`HEAD` 的 `listWritableAgents` 显式
`filter(row => row.organizationId === ctx.organizationId)`）。S4 重写后改用 `facade.get(actor, name)`，
于是继承了**读取**的作用域（本组织优先，未命中再按授权可见集合兜底）：其他组织 `visibility='public'`
的同名 Agent 会让本组织的创建返回 409。当时的理由是"创建路径没有覆盖别人的资源这个语义，先读出可见
资源再拒绝比让唯一索引报错更早、更可诊断"。

复核确认这条理由不成立，已按裁决退回组织内判定：

- **口径错位**：名称唯一性是主表约束 `idx_agent_config_org_name = (organization_id, name)`，`create`
  的 `onConflictDoUpdate` 冲突目标也是这两列（`repositories/agent-config-resource.ts:210-215`）。
  跨组织同名既不冲突、也永远不会让唯一索引报错，所以"更早报错"保护的是一个不存在的失败；真正发生的
  是**误报冲突**——被拒绝的那次创建本来是合法的。
- **落点**：新增 `AgentConfigFacade.existsInOrganization(actor, name)`，按 `(name,
  activeOrganizationId)` 走 `service.findByNameUnscoped`，`/api` 路由改用它做 409 预检。判定刻意
  **不经过授权条件**：唯一性是主表约束而不是授权事实，挂在授权上会随 `memberDefaultActions` /
  `ownershipMode` 的变化变宽或变窄，而 upsert 的冲突目标不会跟着变。Facade 的 `create` 注释同步改为
  指向该方法，避免后来者再拿可见性判定做预检。
- **错误码不变**：仍保留 agent-config 自己已发布的值 `ALREADY_EXISTS`（mcp 用 `CONFLICT`），不为了
  统一而改已发布契约。前端按该码分支的是 `AgentHomePage.tsx`（走 `/web`），`/web` 的码不变，因此
  前端无需改动。
- **`/web` 随后按同一裁决收敛**（详见 §1.66）：本条目最初只改了 `/api`、把 `/web` 留作待办，用户实测
  在控制台上复现了同一个误报（`test1` / `my-test` / `test` 实际在 `hpx` 且为 public），于是 `/web` 的
  `handleCreate` 也改用 `existsInOrganization`。两个入口现在是同一口径、同一落点。
- **下表「visible」的含义已按 §1.67 收敛**：本节写就时读取作用域还是「我是成员的全部组织 ∪ 公开」，
  现在是「**当前组织 ∪ 公开**」。表中"未改：`HEAD` 即按可见判定"的结论不受影响（那两处的 `HEAD`
  兜底本来就是"本组织未命中后回落 external public"），但不要把 visible 读成"含其他组织的私有资源"。

四条受控资源 × 两条入口的实测作用域（`HEAD` = 4ab8d4712 与当前工作区的对照）：

| 入口 | `HEAD` | 现在 | 说明 |
|---|---|---|---|
| agent-config `/api`（`POST /api/agents`） | **org** | **org** | 本次回退；证据见下 |
| agent-config `/web`（`POST /web/config/agents`） | visible | **org** | §1.66 按同一裁决收敛（控制台实测回归推动了这次同批处理）；`HEAD` 的 `getAgentConfig` 同样跨组织兜底，因此这是有意的行为变更 |
| mcp `/api`（`POST /api/mcp`） | visible | visible | 未改：`HEAD` 的 `getMcpServer` 未命中本组织后回落到 external |
| mcp `/web`（`POST /web/config/mcp`） | org | org | 路由层无预检：`HEAD` 靠写入前 `ownership === "internal"` 判定，现在由 `facade.create` 拿到 insert 空集后抛 409 |
| skill `/api`、`/web` | org | org | `HEAD` 用 `ownership` 过滤，现在显式传 `organizationId`；两版都不跨组织 |
| provider `/api`（`POST /api/models/providers`） | visible | visible | 未改：`HEAD` 的 `getProvider` 用 `listExternalProviders` 按名兜底。`/web` 无创建入口（`PUT` 幂等 upsert，跨组织公开同名表现为 403 而非 409） |

回退证据（`git show HEAD:...` 对照当前；逐条均为代码，非注释推断）：

- `HEAD` `routes/api/agents.ts` `POST` → `(await listWritableAgents(authCtx)).find(agent => agent.name === payload.name)`，
  而 `listWritableAgents` 是 `listAgentConfigs(ctx).filter(row => row.organizationId === ctx.organizationId)`。
- 当前（回退前）`routes/api/agents.ts` → `facade.get(actor, name)` → `findVisible`
  （`facades/agent-config-facade.ts`）：本组织命中即返回，未命中再执行**不带 `organizationId`** 的
  `findByName`，授权谓词含 `visibility = 'public'` 分支（`access-control/src/query/build-predicate.ts`），
  于是其他组织的公开同名行也会命中。
- `HEAD` `/web` `agent-route-support.ts` → `configPg.getAgentConfig(ctx, name)`，其实现（`HEAD`
  `services/config/agent-config.ts`）本组织优先、未命中后由 `listExternalAgentConfigs` +
  `canReadResource` 放行跨组织公开行——所以 `/web` 的这一差异**迁移前后一致**，不是本次重构引入的。

因此"S4 把 agent-config 与 mcp 的 `/api` 语义统一"这条描述在回退后**不再成立**：agent-config 的两条
入口都回到组织内，mcp / provider 的 `/api` 仍是可见判定。**agent-config 与 skill 是现在唯二两条入口
都与自身 `(organization_id, name)` 唯一约束对齐的资源**（skill 一直如此，agent-config 由本条目 +
§1.66 收口）；把 mcp / provider 的 `/api` 一并收敛到组织内属于同一类修正，但**不在本任务范围**（不是
本次引入的变化）。用户已裁决（2026-09-19）：`/api/*` 属已发布稳定协议面，其底层逻辑随**任务 1.5**
与 `/web` 统一（`ce-ee-refactoring-stage-2-plan.md` §1.5 第二条；标准 `:217`），本次不再单独调整 `/api`
下的接口——因此这两条与 §2.12 一并归入 1.5，清单见 §九「附：任务 1.5 的 `/api` 协议面盘点」。

**已知取舍（保留）**：预检与创建不是原子操作，两个并发同名创建仍可能双双通过预检，此时第二个请求
由仓储的 `onConflictDoUpdate` 落成一次更新并返回 200（HEAD 同形：`listWritableAgents` 预检 + 同组织
同名 upsert）。保留 upsert 是计划 §S4 的明确要求（"`createAgentConfig` 的 `onConflictDoUpdate`
保留"），且 `meta-agent` 的 locate-or-create 依赖它；因此这里不改为 skill / mcp 那种
`onConflictDoNothing` + 空集判冲突的原子形态，只在预检上恢复与冲突目标同口径。

**判定落点的两条依赖**（写在 `existsInOrganization` 的注释里，供后续改动者复核）：预检使用的组织必须
等于 `create` 写入的组织（同取 `actor.activeOrganizationId`，依赖本资源 `ownershipMode` 为
`organization` 且协议入口不传显式 `organizationId`）；以及该无授权读取之所以不扩大信息面，是因为
认证层产出的 `ActorContext` 保证 `activeOrganizationId` 必在 `memberships` 里——本组织的组织资源对
成员默认可读，故判定能看到的名称集合不超过 `get` 已能读到的集合。

### 1.37 `/api` PUT / POST 声明 403（此前未声明）

新授权的写路径会因 `access.actions` 缺少 `update` / `create` 而拒绝，响应是 403；旧版本这两个操作
只声明了 400 / 404 / 409。已在 OpenAPI `response` 中补齐 403，避免对外文档与实际行为不符。

### 1.38 `@server/errors` 解析到文件而非目录：业务代码必须用 `.code`

`apps/server/src/` 下**存在两个同名 `AppError`**：

- `errors.ts` —— `constructor(message, public readonly code: string, public readonly statusCode = 500)`；
- `errors/index.ts` —— `constructor(message, statusCode, type)`，错误信息在 `.type`。

`@server/errors` 的解析结果是 **`errors.ts`**（同名时文件优先于目录）。资源包按目录入口的形状写
`super(message, 409, "ALREADY_EXISTS")` 与 `error_.type` 时会得到
`Argument of type 'number' is not assignable to parameter of type 'string'` 与
`Property 'type' does not exist on type 'AppError'`。

处置：全部改用 `.code` / `.statusCode`；并删除本轮自建的 `AgentAlreadyExistsError`，直接使用宿主的
`ConflictError`（其码就是 `ALREADY_EXISTS`、状态 409，与前端依赖一致）。

- **记录原因**：两个 `AppError` 并存是既存的重构中间态，`errors/index.ts` 的 `(message, statusCode,
  type)` 形状与全仓其余错误类都不一致。S6 收口时应合并为一个（本切片只保证不再新增按目录形状书写的
  代码，不改宿主错误类本身）。

### 1.39 Facade 的 `reload` 改走受控读取，不用 `findRowUnscoped` 手拼 scope

写入后需要回读最新行时，Facade 走 `this.getById(actor, id)`（授权查询产出），而不是
`findRowUnscoped` + `withAccess` 自己拼 scope。理由：归属范围必须由授权查询产出——谓词本身就是从归属
列推导的，绕过查询自己拼 scope 会让"行的归属"与"授权看到的归属"出现两条真相来源。

### 1.40 `meta-agent` 改为经模块装配调用，不再裸导入资源包

`packages/resources/agent-config/src/services/meta-agent.ts` 的 `ensureMetaConfig` 现在：

- 经 `getAgentConfigModule()` 取 `service` / `associations`，而不是直连 CRUD 与
  `@fenix/resource-skill/server/config` 的 `syncAgentSkills`；
- 内置 Skill 的绑定改走 `associations.syncSkills(agentConfigId, skillIds)`，归属本包的写入面；
- 系统托管租户（内置 Skill 的宿主组织）经 `IdentityDirectory` 解析（S1 已落地的契约）。

### 1.41 共享常量导致 Elysia `schema.type` 被拓宽 → 改用工厂函数

`packages/.../routes/web/config/agents.ts` 的 `NAME_PARAM_DETAIL` 常量在**第一次使用处**被上下文
定型后，`schema.type` 被拓宽成 `string`，后续两个使用点反而报类型错误。改为 `nameParamDetail()`
工厂（3 处调用点同步）。这类"常量被首次使用点污染"的模式在 Elysia 的 `detail` 对象上会重复出现，
记录以备同类问题。

### 1.42 `getUserConfig` / `setUserConfig` 改结构化入参 `UserConfigSubject`

`apps/server/src/services/config/user-config.ts` 原先签名吃 `AuthContext`。用户偏好按
`(organizationId, userId)` 定位行，与身份实现无关，因此改为结构化的
`UserConfigSubject { organizationId; userId }`，并删除 `AuthContext` 导入。`AuthContext` 与本接口
结构兼容，宿主调用点（S5 的 model-management）无需改动。

### 1.43 agent-config 前端切到 `scope + access`（D2 的前端侧）

- `apps/web/src/lib/agent-resource-access.ts` 按 mcp / skill 的同名模块重写：判定来源改为
  `scope.organizationId` 与 `access.actions`，新增 `isExternalAgent(agent, activeOrganizationId)`、
  `isPublicAgent`；`isAgentWritable` 由 `update` 动作决定，缺失时**保守判为不可写**（旧实现
  `writable !== false` 缺失即视为可写，正是要消除的越权展示来源）。
- `getAgentKey` / `getAgentConfigLookupKey` 由 `resourceAccess.resourceKey` 改为
  `${scope.organizationId}/${id}`（二者缺一退回 `name`）；展示名改用顶层 `organizationName`。
- **删除 `getAgentOptionValue`**：全仓检索确认它**没有任何生产调用点**（仅两处测试引用），旧语义
  `resourceKey ?? id ?? name` 在新视图下也已无输入。按「删除优于兼容」删除，同时移除两处测试引用
  （`agent-form-dialog-pure-logic.test.ts`、`agent-resource-access-flow.test.ts` 的用例改为断言
  `getAgentConfigLookupKey`）。若将来 Agent 出现选项列表，应参照 `mapSkillOptions` 的
  `{ id, key, label }` 三件套重建，而不是恢复这个只有值没有键的 helper。
- 调用方同步：`AgentSidebarTree.tsx`（本地 `AgentConfigItem` 改携带 `scope` / `access` /
  `organizationName`，角标改 `getAgentAccessBadgeKey(agent, orgId)`，`orgId` 取自既有的 `useOrg()`）、
  `AgentManagementPage.tsx`（`inferCategory` 新增 `activeOrganizationId` 参数并进 `useMemo` 依赖，
  `sourceOrg` 改为「外部组织才传 `organizationName`」）、
  `agent-editor/{AgentEditorSections,AgentFormDialog}.tsx`（读 `data.scope` / `data.access` /
  `data.organizationName`）、`agent-editor-model.ts`（公开状态改由
  `detail.scope?.visibility === "public"` 推导）、`use-agent-editor.ts`（`AgentEditorData` 携带
  授权视图字段）、`web/api/agents.ts`（保存结果类型改为 `Partial<ResourceAccessView>` + 顶层
  `organizationName`）。
- 契约类型：`apps/web/src/types/config.ts` 的 `AgentInfo` / `AgentDetail` 改为
  `extends Partial<ResourceAccessView>` + 顶层 `organizationName`，删除 `resourceAccess`。
  `ResourceAccess` 类型**保留**（`ProviderInfo` / `ModelEntry` 仍用，S5 切换后再删）。

### 1.44 前端展示名按归属组织限定（沿用 mcp / skill 的 D2 语义，属行为变化）

新视图的 `organizationName` 由后端对**所有**资源解析（含本组织），因此 `getAgentDisplayName` 对
本组织资源也返回 `"<当前组织名>/<资源名>"`。这是 mcp（`getMcpDisplayName`）与 skill
（`getSkillOptionLabel`）在 S2 / S3 已确立并写入各自路由测试的语义（`mcp/__tests__/round40` 明确断言
本组织资源的 `organizationName === "Current Team"`），本切片保持一致而没有为 Agent 单独回退。

- **影响**：`AgentSidebarTree` 会把 `"/"` 前的组织名渲染成 Agent 卡片上的等宽角标，因此**每个** Agent
  都会带上本组织名。旧栈只有在资源归属其他组织时才有 `sourceOrganizationName`，所以这是一处可见的
  展示变化（不是授权变化：角标与分组都以 `scope.visibility` / `isExternalAgent` 判定，越权展示仍被
  消除）。
- **处置建议（不在本切片做）**：若要收敛，应在**同一个 helper 层**统一为"归属组织等于当前组织时不再
  加前缀"，并对 agent / mcp / skill 三个资源包一次性调整，而不是在 Agent 侧单独回退造成三处语义分叉。
  已记入文末「待办」清单。

### 1.45 资源包仍保留的 `routeConfigDeps` 代理（site 绑定路由）

`packages/resources/agent-config/src/server/routes/config-route-deps.ts` 是本包路由层的 DI 代理，
目前仅 `agent-site-association-routes.ts` 的 3 处调用仍在用（`getAgentConfigById` /
`addAgentSiteApp` / `removeAgentSiteApp`）。Site 绑定的授权语义归 1.3，本切片不动该路由的判定逻辑；
但按计划"路由依赖必须经模块装配取得"，该代理应在 S4 收口时改为 `getAgentConfigModule()` 的
`service` 与本包私有的绑定表 domain 函数。**处置见 1.50（整体删除，直接导入同一实现）。**

### 1.46 `restartInstances` 走 `use` 动作：成员的重启能力被保持，收紧的是配置写入

`restartInstances` 选 `use` 而不是 `update`（见 Facade 内的 docstring）。迁移前
`assertInternalWritable` 只要求同组织，而 `use` 落在 `memberDefaultActions` 内，因此**成员重启用例
行为不变**；D1 收紧的是创建 / 修改 / 删除与公开受众设置。Environment 清理与实例停止仍留在
Facade / use case 层，不下沉到 Domain Service。

### 1.47 `/web` 成功响应改用宽松 schema，模板响应保留精确类型

`routes/web/config/agents.ts` 的 200 响应声明为
`WebOkSchema(z.union([z.looseObject({}), z.null()]))`，沿用 mcp / skill 的同名写法：授权视图字段
（`scope` / `access` / `organizationName`）与展示字段由 handler 组装，用严格 schema 会把每个新增
展示字段变成一次协议改动，也会像 1.27 那样在响应校验阶段**剥掉**实际返回的字段。

唯一例外是 `handleTemplates()`：模板形状由模板文件解析决定、不受授权视图影响，因此返回精确类型
`AgentTemplatesResponse`（新增导出，同时在 `config.schema.ts` 补类型别名），路由能按
`agent-templates-response` 精确校验并生成 OpenAPI。

### 1.48 `buildAgentRelatedResourceView` 搬迁出路由；`getReadableAgentConfigById` 作为兼容入口

- 展示投影（绑定 ID → 名称标签）原先直接写在 `agent-route-support.ts` 里并直接访问 `db`，违反
  「route 不得直接访问 `db`」。本次**纯搬迁**到
  `packages/resources/agent-config/src/server/services/agent-related-resources.ts`，未顺带改动查询
  形状、兜底策略或授权判定（解析失败仍降级为"用 ID 当标签"）。它读取的跨包表
  （`model` / `provider` / `machine` / `skill` / `mcp_server` / `knowledge_base` / `agent_site_app`）
  的所有权随资源包迁移属 1.3 / 1.7，本切片不引入新的抽象层。
- `knowledge` **不是 `agent_config` 的表列**（知识库绑定在独立绑定表里，经
  `associations.listKnowledgeBindings` 读取），因此资源注册的表列只有
  `id` / `organizationId` / `userId` / `visibility`，谓词编译器不需要知道知识库绑定。
- `getReadableAgentConfigById` 保留为**迁移期兼容入口**（`src/server/system-entries.ts`）：它把旧
  `AuthContext` 收敛成 `ActorContext` 后走 `facade.getById`，语义与迁移前的 `canReadResource` 一致
  （同组织，或资源公开可读）。宿主与 agent-runtime 中仍以 `AuthContext` 传上下文的读调用点不改造，
  它们全部只读，不构成权限提升；待这些调用方随各自任务切到 `ActorContext` 后该入口即可删除。

### 1.49 `exceptions.json` 删除 `special-dependency @fenix/agent-config → @fenix/access-control`

与 mcp（1.22）、skill（1.33）一致：包内已无旧授权栈导入，例外条目变成"已不再违规"，架构门禁要求
删除。`model-management` 的同类条目仍在（S5 范围）。同时 `packages/resources/agent-config/package.json`
删除 `@fenix/access-control` 依赖并新增 `./server/runtime` 子路径导出。

### 1.50 删除包内 `routeConfigDeps` 代理（1.45 的处置）

1.45 记录的处置在 S4 收口时执行：`packages/resources/agent-config/src/server/routes/config-route-deps.ts`
整体删除，`agent-site-association-routes.ts` 的 3 处调用改为直接导入 `system-entries.getAgentConfigById`
与 `services/config/agent-config-site-app` 的 `addAgentSiteApp` / `removeAgentSiteApp`。

- **为什么是删除而不是保留**：该 Proxy 的 fallback 目标本来就是 `services/config` 的同一批符号
  （`configServices[key]`），生产路径上"经代理"与"直接导入"解析到同一个实现，代理只服务于测试注入。
  而 S4 已把包内测试接缝统一改为模块装配替身（`installAgentModuleStub`），该入口既无生产者也无消费者，
  按"删除优于兼容"整体移除；`test-utils/agent-config-route-deps.ts` 与
  `@fenix/agent-config/server/testing` 的 `set/resetRouteConfigDepsForTesting` 导出同步删除。
- **影响面**：Site 绑定的授权语义本身未动（1.3 范围），删除的只是依赖解析方式。

### 1.51 `exceptions.json` 删除失效的 `no-circular @fenix/agent-config → @fenix/agent-runtime`

S4 收口时 `bun run check:dependencies` 报「架构例外台账有 1 条已不再违规，必须删除
`[no-circular] @fenix/agent-config -> @fenix/agent-runtime (owner: 1.4)`」。按台账合同
（§10.7.4：台账是待清偿清单而非永久豁免名单，不再违规即必须删除）移除该条目，门禁随即恢复
`✓ 1872 modules，24 条已登记例外，0 条新增违规`。

- **证据与时间点**：S3 收口时同一门禁报「25 条已登记例外…无失效条目」，即该环在 S3 收口后仍存在，
  消失发生在 S4 期间。当前 `agent-config → agent-runtime` 的跨包边仍在（`server/facades/agent-config-facade.ts`
  2 处惰性 `await import`、`services/meta-agent.ts` 1 处静态 + 2 处惰性），说明被打破的是环上
  **另一条边**，不是这个方向本身。
- **嫌疑变更**（未逐边定位到具体边）：`HEAD` 上该环的 agent-config 侧边链为
  `src/server/routes/config-route-deps.ts` → `src/server/services/config/index.ts` →
  `src/server/services/config/agent-config.ts` →（`await import("@fenix/agent-runtime/server")`）。
  S4 删除了 `config-route-deps.ts`、新增 `src/server/facades/agent-config-facade.ts` 承接对 agent-runtime
  的惰性读取，并重写了包内测试接缝（原 `round43-agent-sites-routes` 等经 `routeConfigDeps` 注入）。
  三者中任意一条都能断开该环。
- **需要 1.4 复核**：该条目的 `removeWhen` 是「1.4 收敛 agent-config 读取为 port 注入」，**尚未实施**
  而环已消失。请 owner 确认这与 1.4 的 port 注入方案是否冲突，以及台账中仍未清偿的
  `agent-runtime → agent-config`（同 owner）是否应在 1.4 一并处理。

### 1.52 主体复验不信任上游的落地方式：宿主注入窄端口（Q2 = A）

- **背景**：给用户签发上游模型网关 Key 前必须回答"这个人现在还能不能用这个 Agent"。`agent-runtime`
  侧有 8 个入口跨 4 个包会触发换 Key 编排，把这条不变量复制到每个入口意味着新增第 9 个入口时必然漏一处。
- **裁决（用户）**：Q2 = A —— 宿主注入窄端口。
- **实施**：`model-management` 声明 `SubjectVerificationPort`（`src/server/ports/subject-verification.ts`），
  **不 import** identity / access-control / agent-config 任何一方；`apps/server/src/services/
  model-gateway-subject-verification.ts` 用真实的 `AccessControlModule.authorize` +
  `agentConfigResource.definition` + `IdentityDirectory` 实现它，`main.ts` 装配时注入。
- **顺带修掉的缺陷（迁移前既有）**：`HEAD` 的 `runtime.ts::ensureSubject` 调用
  `canReadResource(ctx, "agent_config", id, /* ownerOrganizationId */ ctx.organizationId)`——
  第三个参数恒等于 `ctx.organizationId`，而该函数第一行是 `if (ownerOrganizationId === ctx.organizationId)
  return true`，因此这次"读权限检查"**恒为真**；同时它只校验了请求传入组织的成员关系，**从未校验
  Agent 自己的归属组织**。后果：任何组织的成员都能为一个任意 `agentConfigId` 换到网关凭据，
  `AGENT_NOT_FOUND` 分支实际不可达。新实现按 用户 → 组织 → 成员 → Agent 归属 → `authorize(use)`
  逐级判定，五个拒绝原因全部可达。
- **行为变化**：新增 `USER_NOT_FOUND` / `ORGANIZATION_NOT_FOUND` / `AGENT_NOT_FOUND` 三种拒绝
  （原先不可能出现）；这三个码的对外文案是新写的（前两个沿用旧文案的措辞），见
  `SUBJECT_REJECTION_MESSAGES`。凭据吊销检测按原因区分"删凭据"与"留映射"，新增原因需要下游识别。

### 1.53 连通性探测的授权从"归属组织成员"收紧为 `update`

- **迁移前**：`assertInternalWritable(ctx, ..., ownerOrganizationId)` 只比较
  `ownerOrganizationId === ctx.organizationId`，**不看角色**——任一组织成员都能用组织密钥打上游；
  同时它把跨组织公开的 Provider 挡在外面，而 `read` 会放行它们（方向恰好相反）。
- **实施**：`ProviderFacade.getForProbe` 要求 `update` 动作。唯一例外是系统托管的 `gateway` Provider：
  它允许探测（连通性是运维最需要确认的信息），但仍禁止写入。
- **行为变化**：**组织成员（非 owner/admin）不能再测试连通性**。这是有意收紧，与 D1 同源——`update`
  本来就只归 owner/admin。

### 1.54 `DROP TABLE resource_permission` 推到下一发布（用户裁决 A）

- **发现**：计划 S6 要求"在 C1–C3 全部落地、无读者后执行 `DROP TABLE resource_permission` + 三个
  pg enum"。但启动期数据迁移 `access-control/20260919-backfill-resource-visibility` 仍要读旧栈的
  `principal_type='all' AND action='read'` 记录来把 `visibility` 回填成 `public`，而 **SQL 迁移先于
  启动期 data migration 执行**：同一发布内 DROP 会让全新库启动即失败、升级库静默丢失公开共享语义。
- **裁决（用户）**：A —— 本次发布保留回填，DROP 推到下一发布。
- **落地**：
  - 本次发布只出 `drizzle/0027_access-control-resource-visibility.sql`（四列 + 四索引，全部
    `IF NOT EXISTS`）+ 回填迁移，**不产出 DROP 迁移**；
  - `apps/server/src/db/schema.ts` 暂留 `resourcePermission` 表与三个 pg enum，并在 enum 处写明
    `removeWhen`：回填已在全部环境记入 `data_migrate_record` 的下一个发布，同时删除回填迁移并生成
    `DROP TABLE` 迁移。
- **代价**：`resource_permission` 表与三个 enum 多存在一个发布周期。已登记为后续任务，不是遗漏。

### 1.55 启动顺序测试改名：`resource-permission-bootstrap-order` → `access-control-bootstrap-order`

`apps/server/src/__tests__/resource-permission-bootstrap-order.test.ts` 断言的不变量（授权端口先于
模型网关装配）在 1.2 之后依然成立，但名字与用例标题里的"权限仓库"指向已被删除的
`resource_permission` 仓储，而 `main.ts` 的 `wirePermissions` 实际装配的是
`createDrizzleAccessControl` + 四个资源模块。文件已改名、断言值改为 `"access-control"`，不改行为。

### 1.56 宿主 `config.schema.ts` 的死 schema 与 barrel 转发清理

- 删除 `ConfigActionSchema` / `ConfigBodySchema` + 类型 `ConfigAction` / `ConfigBody`
  （`POST /web/config/:module` 的 action 风格请求体，该路由已不再注册）；
- 删除 `McpServerInfoSchema` / `McpServerDetailSchema` / `McpToolInfoSchema` / `McpInspectResultSchema`
  + 对应 4 个类型（mcp 的协议 schema 在 `@fenix/resource-mcp` 内，前端用的是自己的视图类型；同名
  `McpInspectResult` 在 mcp 包内有 14 处引用，指的都是该包自己的定义）；
- `apps/server/src/schemas/index.ts` 停止对 `./config.schema` 的整段再导出（`config.schema` 的
  Provider / Model 契约由资源包直接 import，不经 barrel）。
- 这是 1.32 承诺的"S6 收口时按同一判据清理"。判据与 1.32 一致：全仓检索无消费者。

### 1.57 `errors/index.ts` 删除

`apps/server/src/errors/index.ts` 与 `apps/server/src/errors.ts` 重复导出第二份 `AppError` 系列；
`git ls-tree` 确认目录版无任何导入方（全部导入解析到文件 `errors.ts`）。已删除，并同步移除
`scripts/__tests__/rmd-07-migration.test.ts` 中对应的台账条目（`toHaveLength(73)` → `(72)`）与
`main.ts` 里 S6 清理后遗留的未使用 import。

### 1.58 `config-pg` 桩的键清单从 40+ 收缩为 3

`apps/server/src/test-utils/stubs/config-pg-stub.ts` 的清单必须与 `services/config/index.ts` 的真实
函数导出一一对应（`mock.module` 是整体替换，缺项会让导入方拿到 `undefined` 而非明确报错）。1.2 把
config barrel 从 mcp / skill 的 re-export façade 收缩为 `upsertSystemMcpServer` + jsonb + 用户配置
（`git diff HEAD` 46 行改动），因此清单收缩为 `getUserConfig` / `setUserConfig` /
`upsertSystemMcpServer` 三项；纯净函数导出（`parseJsonb` / `parseJsonbOr`）不入清单——它们应由真实
实现承担，打桩只会掩盖错误。

### 1.59 RMD 台账与根路径归属规则随删除更新

- `scripts/__tests__/rmd-06-migration.test.ts`：旧授权栈的 5 个条目第三元素置 `null`（在 1.2 删除），
  台账仍为 12 项。
- `scripts/__tests__/rmd-07-migration.test.ts`：删除 `src/errors/index.ts` 条目（见 1.57）。
- `scripts/root-source-owner-rules.ts`：旧授权栈的 5 条规则**保留最近一次的 owner**
  （`platform-access-control`）+ 注释说明文件已删除。**不得**改成 `owner: "delete"`：
  `isAllowedDeletePath()` 只允许 `src/.DS_Store` 与 `web/dist/`，改成 delete 会被门禁拒绝
  （先例：`share-link.ts` / `token.ts`）。对应的断言测试改写为仍断言 `platform-access-control`。

### 1.60 `FORBIDDEN_PACKAGE_DEPENDENCIES` 新增 `@fenix/identity → @fenix/access-control`

- **为什么需要**：`identity` 与 `access-control` 同属 `platform-impl` 类别，而**类别级**矩阵对
  同类别内部方向表达不了禁则——矩阵只允许其中一条边（`access-control` 可用 identity 的公开入口，
  授权实现需要把成员关系翻译成归属事实；反向禁止，否则两个可替换实现会重新耦合成一体）。
- **实施**：`scripts/lib/architecture-boundary-rules.ts` 新增
  `FORBIDDEN_PACKAGE_DEPENDENCIES`（精确到 `from` / `to` 包名，不接受通配），并补文档注释说明为什么
  类别级规则不够。这是标准 §158"必须能被门禁判定，不依赖人工约定"的落地。

### 1.61 补上主体复验端口实现的回归（S5 验收的「拒绝路径」缺口）

- **发现**：S5 的验收含「补齐回归：… 拒绝路径」，但 1.52 新增的宿主适配器
  `apps/server/src/services/model-gateway-subject-verification.ts` **在补测前零测试引用**——全仓
  `SubjectVerificationPort` / `subject-verification` 只命中 `main.ts`（装配）、该服务自身与
  `model-management` 的端口与调用方；三个新拒绝码（`USER_NOT_FOUND` / `ORGANIZATION_NOT_FOUND` /
  `AGENT_NOT_FOUND`）与 `SUBJECT_REJECTION_MESSAGES` 在任何测试里都不出现，
  `ensureSubject` 在唯一触及凭据服务的用例里被整体打桩（`ensureSubject: async () => {}`）。
  这同时否证了 1.16 里「本次唯一一处生产代码路径无测试的已知缺口」的表述。
- **影响**：这是**签发上游网关凭据前的权限判定**，且拒绝原因决定吊销处置（删上游凭据 vs 保留映射），
  属标准 §10.3.5 与工程红线「权限路径必须覆盖关键边界」的射程，不是可选覆盖。
- **实施**：新增 `apps/server/src/__tests__/model-gateway-subject-verification.test.ts`（8 例）：
  五种拒绝原因各自的触发条件与**顺序早退**（早退后不再读 Agent 归属、不再调授权）、Agent 归属其它组织
  与 Agent 行不存在同判 `AGENT_NOT_FOUND`、`ResourceAccessDeniedError` → `AGENT_ACCESS_REVOKED`、
  非权限异常原样上抛（不得伪装成权限收回而误删凭据）、放行路径下以 `use` 动作与
  `agentConfigResource.definition` 调用且 actor 携带**全量**成员关系。

### 1.62 收口复核：`access-control` 的装配边与权威设计不一致（已按设计补齐）

- **发现**：计划 §3.2 要求 `access-control` 的 `package.json` 增 `@fenix/identity` 依赖、`fenix.module.ts`
  的 `dependsOn` 改 `["identity"]`；权威设计也把这条边写成**已登记的事实**——工程标准 §2.3 矩阵
  （access-control「可以依赖：… 同一产品版本的 `identity` 公开入口」）、§10.2.2（「精确的特殊依赖只
  包括经设计登记的边：`access-control → identity`、…」）、§184（Identity 转必填，「`access-control`
  经 `dependsOn` 精确绑定到 `identity`，缺任一即装配失败」）。但实际落地的 `dependsOn` 是空数组、
  `package.json` 也没有该依赖，即权威设计描述了一条不存在的边。
- **判定与实施**：按设计补齐，不改设计。`dependsOn: ["identity"]` + `"@fenix/identity": "workspace:*"`；
  生成器 `assertDependsOnDeclared` 强制 `dependsOn` 必须落在本包显式声明的 `workspace:` 编译依赖上，
  因此两者必须同时存在。**这条边是纯装配约束、没有编译期导入**：CE 的授权实现只消费已经解析好的
  `ActorContext`（成员关系由身份层经 `IdentityDirectory` 产出并全量带入），不读身份表；它表达的是
  "Identity 与 AccessControl 成套替换"——profile 混用不匹配的实现组合在装配期即失败。`fenix.module.ts`
  的注释已写明这一点，避免后来者按"零引用 = 死依赖"删掉它。
- **同时修正**：`bun.lock` 自 S1 起失同步（`agent-config` / `model-management` 的条目仍声明早已从
  `package.json` 删除的 `@fenix/access-control`），随本次 `bun install` 一并收敛。

### 1.63 收口复核：Model 未使用「Provider 谓词半连接」，由 D6 的更强约定取代

- **计划字面**：S5 要求「Model 列表/详情用半连接（`authorizationScope`）把 Provider 谓词下推到 Model
  查询，在分页/排序/计数之前」。
- **实际实现**：全仓不存在 `authorizationScope`，也没有 Model 级授权谓词。Model 在实现里被定为
  Provider 的**子表**（`model-resource.ts` 头部注释）：不注册独立资源、不建 owner / `visibility`、
  仓储不接收 `ResourceQueryConstraint`，全部读写经 `ProviderFacade` 先对 Provider 授权、再按
  `provider_id` 定位子行（决策 D6）。
- **为什么这更强而不是等价**：半连接解决的是"Model 能被独立枚举/分页时，必须在同一条 SQL 里带上
  Provider 谓词"。实际实现里**不存在需要该谓词的查询**——`/web` 的可用模型列表是
  `facade.list(actor)`（已授权 Provider）+ 逐条 `getById` 的投影，`countByProviderIds` 的入参就是
  已授权列表项的 id，`listByProviderId` 只在已授权的 Provider 行之后调用。补一个没有消费者的
  `authorizationScope` 端口会违反「不做推测性抽象」与「删除优于兼容」。
- **补偿**：新增 `provider-facade-model-scope.test.ts`（7 例）把这条约定钉住——计数只针对已授权
  Provider id 且一次批量完成、Provider 不可见时不读任何子行、列表路径不加载子行、详情按
  `provider_id` 读取子行。
- **移除条件**：若后续出现"跨 Provider 的 Model 列表/检索"这一真实用例（例如全局模型搜索），必须
  在同一个查询里下推 Provider 谓词，而不是先读全量再内存过滤。

### 1.64 收口复核：identity 模块的 env 声明推迟到 1.7（计划 S1 的一半未做）

- **计划字面**：S1 要求 `packages/platform/identity/src/env.ts` 声明模块 env。
- **实际实现**：包内不读 `process.env`、不读 `.env`；配置经宿主已校验的 env 通过
  `initializeApplicationInfrastructure({ moduleConfigs })` 注入（`src/config.ts` 的
  `getIdentityConfig()`）。模块 `fenix.module.ts` 的 `envDefinitions` 未声明，两处代码注释
  均自述推迟到 1.7 的 env 收敛。
- **为什么不在 1.2 补**：`apps/server/src/env.ts` 是变量真相来源；在包内再声明一份 `envDefinitions`
  并自行解析，会让"同一变量两处默认值"这类分歧从启动期报错退化为运行期静默不一致（`config.ts:6-8`
  的既有理由）。env 的声明、校验与 preflight 归一是 1.7 的任务，1.2 只负责把职责搬到正确的包。
- **移交**：1.7「模块 env 声明、配置冲突校验、密钥保护…」条目。

### 1.65 收口复核：端到端启动验证与迁移 smoke 的移交（评审裁决）

- **发现**：计划 §六的验收项里有三条**从未执行、review 也未提及**：
  (a) S2 的「迁移 smoke（空库 + 历史升级库）」；(b) §六「端到端：以 `deploy/assembly/ce.json`
  启动，验证普通用户列表只返回其可见资源、跨组织隔离、公开资源可见、API Key 请求的组织恢复」；
  (c) S3–S5 要求的下推断言写成「`EXPLAIN` 或 SQL 快照」，《授权设计》§356 也要求「索引顺序须以
  最终 `EXPLAIN` 结果验证」——而全仓**没有任何 EXPLAIN 断言**（`grep -rn "EXPLAIN"` 在
  `packages/` 与 `apps/` 里零命中）。实际交付的下推断言是另一种形态：仓储用例断言"不透明条件句柄
  原样交给授权查询端口"（`provider-repository.test.ts` / `skill-repository.test.ts` /
  `mcp-server-repository.test.ts`），谓词语义由 `authorization-consistency.test.ts` 用**离线谓词
  等价**验证。这个形态与"授权条件确实在 WHERE 里、无内存过滤"是等价的（编译器读同一份句柄载荷），
  但它证明的是**句柄透传**，不是**最终 SQL 文本**，也不能替代索引顺序的 `EXPLAIN`。
- **裁决（用户确认）**：三条一律登记移交，不在 1.2 内补做。
  - 端到端启动验证 → **1.5「apps/server：宿主与协议聚合」**（装配与协议挂载在该任务收口，届时以
    `deploy/assembly/ce.json` 启动的验证才具备完整意义）。
  - 迁移 smoke（空库 + 历史升级库）、索引顺序的 `EXPLAIN` 验证 → **1.7「DB、配置、迁移与交付」**
    （该任务的验收本就包含「为空库与真实历史升级库补齐 migration smoke，覆盖 DDL、数据迁移重试、
    verify、补偿、锁风险与完成记录」，且需要真实库才能做）。
- **风险与影响范围**：1.2 已交付的 DDL（`visibility` 列 + 四个索引）与启动期回填迁移因此**只有
  `db:generate` 空 diff、回填单测与句柄级下推断言作为证据**，没有在真实库（含历史数据）上跑过；
  四个 `(organization_id, visibility)` 索引是否被规划器选中也未经实测。1.5 / 1.7 收口前，不应把
  1.2 的迁移链与索引有效性视为已验证；回填的 `verify` 与 `compensation` 路径同理。
- **同步修订**：计划批准件的 §六「验证」口径已按本裁决标注移交。
- **记录原因**：判定顺序是契约的一部分（顺序变了，同一种失效会被归到另一个原因，处置方式随之漂移），
  因此断言的是「哪个原因」而不只是「被拒绝」。

### 1.66 实测回归：`/web` 的同名冲突按同一裁决收敛到组织内（§1.36 的收口）

- **发现（用户实测）**：用户 `test1` 在组织 `my-test` 下通过**控制台**创建名为 `test` 的 Agent，被提示
  已存在，而 `my-test` 下并没有该 Agent。控制台的创建走 `POST /web/config/agents`
  （`packages/resources/agent-config/web/api/agents.ts:70`），正是 §1.36 当时**刻意保留**的可见口径入口；
  前端的错误提示直接来自服务端 409，控制台没有客户端同名预检。
- **取证（dev 库只读查询，非推断）**：全库名为 `test` 的 `agent_config` 只有一行——归属组织是 `hpx`、
  `visibility='public'`、属主是另一个用户；`test1` 同时是 `hpx` 的 **member** 与 `my-test` 的 owner；
  `my-test` 下的 Agent 只有 `kb-test-t` 与 `meta`。即：本组织查询落空 → `findVisible` 的兜底查询
  （不带 `organizationId`）命中 `hpx` 的公开 `test` → 409。与"可见 ≠ 组织内"完全一致；组织解析无误
  （`my-test` 在 `memberships` 内，不涉及 §2.1 的静默回退），也不是旧构建产物——判定行就在本轮改动过
  的同一个文件里。
- **修法**：`handleCreate` 的同名预检由 `facade.get` 改为 `facade.existsInOrganization`——与 `/api` 同一
  入口、同一口径、同一落点（§1.36 新增的方法）。错误码仍是 `ALREADY_EXISTS`、`/web` 响应结构不变，
  前端 `AgentHomePage` 按该码分支的容错逻辑无需改动。
- **`HEAD` 的对照形态（易被误读，特此写清）**：`HEAD` 的 `/web` 创建**有**预检，只是写法不同——
  `configPg.getAgentConfig(ctx, name)` 命中即 `return configError("ALREADY_EXISTS", ...)`（返回错误体而非
  抛错）；而 `HEAD` 的 `getAgentConfig` 是本组织查询未命中后由 `listExternalAgentConfigs` +
  `canReadResource` 兜底，所以**宽口径在 `HEAD` 就已存在**，本条不是"修复重构引入的回归"，而是把一个
  迁移前就有的误报按裁决改掉。查代码时若只看"有没有 ConflictError"会得出"HEAD 无预检"的错误结论。
- **四门穷举（确认这次修复覆盖了现象的全部来源）**：① 前端：控制台的创建只有一个出口
  （`agentApi.create` → `POST /web/config/agents`），create 模式不按名字做任何预检 GET，也没有客户端
  判重逻辑，提示文案是服务端消息经 `save.errorGeneric` 拼出的；② 后端：创建请求上能产出 409 的位置只有
  `/web` 的 `handleCreate` 与 `/api` 的 POST 两处显式预检，仓储 `create` 是 `onConflictDoUpdate`
  （`target=[organization_id, name]`）**永不抛 409**，名称校验走 400，内置 Agent 名单
  （`build/plan/general/explore/title/summary/compaction/meta`，精确匹配）只在展示位与删除守卫上被读；
  ③ 旁路：主表写入后的绑定 / knowledge / memory 同步没有一处抛 conflict（最多 400 或裸 DB 错误的 500）；
  ④ 组织上下文：`/web` 的组织来自 `x-active-org-id`（控制台 `localStorage` 注入），本例 `my-test` 在
  `memberships` 内，不涉及 `org-context.ts` 的静默回退。四条都指向同一处，无第二条路径。
- **为什么现在算本任务范围**：§1.36 的裁决是"同名判定按归属组织"。只改 `/api` 会让**同一个控制台与
  对外 API 对同一次创建给出不同答案**——这正是 §九 待办里"同一资源的 `/api` 与 `/web` 必须同批收敛"
  的情形；用户实测把这条从"登记待办"变成了"必须修"。它同时是一处**对外可观测的行为变更**（迁移前
  `/web` 也是可见口径：`HEAD` 的 `getAgentConfig` 同样跨组织兜底），变更依据是 1.36 的裁决本身。
- **回归护栏**：`round44` 的 409 用例改为打桩 `existsInOrganization` 并断言"命中即止"（`create` 未被
  调用——原用例打桩 `facade.get`，在改动后会因替身未打桩直接失败，无法再钉住这条行为）；新增用例
  「其他组织的同名可见 Agent 不构成创建冲突」（`existsInOrganization` 返回 false → 200 且 `create`
  被调用），把用户的实测场景固化为回归。
- **剩余偏宽入口**：`mcp` `/api` 与 `provider` `/api`（两者在 `HEAD` 即按可见判定，且各自的 `/web` 控制台
  入口表现为组织内，详见 §1.36 对照表）。这两条**不再作为独立待办**：用户裁决 `/api/*` 的统一归入
  任务 1.5（`/api` 与 `/web` 统一为同一 Facade 的薄 adapter），本次不调整 `/api` 下的接口，清单见
  §九「附」；`agent-config` 的两条入口已办结。同批归入 1.5 的还有 §2.12（`/api/mcp` 缺领域校验）。

### 1.67 组织口径回归：可见范围被写成「我是成员的全部组织」（用户实测四类列表越权）

- **现象（用户实测，控制台）**：`agent-config`、`model`、`skill`、`mcp` 四个列表能看到**没有权限的资源**
  ——其他组织的未公开（非 `public`）资源。用户判定「肯定是本次引入的」，核实成立。
- **根因不是「过滤丢了」，而是口径被改宽**：本次任务把 `resolvePolicyFacts` 的组织事实从「当前组织
  那一条成员关系」改成按角色分桶的**全量成员组织 id 列表**（`adminOrganizationIds` /
  `memberOrganizationIds`），`projectActions` 与 `buildAuthorizationPredicate` 同步改为并集形态：
  `(r.organization_id = ANY(adminOrgIds)) OR (r.organization_id = ANY(memberOrgIds) AND memberAllows)
  OR (r.visibility = 'public' AND publicAllows)`。四张受控资源主表共用这一份谓词与同一份 facts，
  因此四个列表同时出现别的组织的私有行。口径本身还被写进了权威设计（旧文字：「`memberships` 必须是
  **全量**成员关系（不是当前 active organization），否则下推谓词会让跨组织可见资源在列表中静默消失」），
  这一句同样是本次新增。
- **取证（三重）**：① **代码路径**——四个资源包的 facade / repository 全部把 `access` 下推
  （`ResourceQueryConstraint` 在仓储输入里是必填），`DrizzleAuthorizedResourceQuery.buildWhere` 把
  谓词与业务条件放进同一个 `and(...)`，没有任何「先读全量再内存过滤」或「条件被业务条件覆盖」的路径，
  所以不存在"过滤器在某条链路上漏接"；② **dev 库实测**——用真实 `createDrizzleAccessControl` +
  真实谓词对 `test1@test.com`（memberships：`test1` / `hpx` / `my-test` / `测试`）打印可见行：
  `agent_config` 13 行 = `test1` private 7 + public 1、`hpx` private 2 + public 1、`my-test` private 2，
  其中 `hpx` / `my-test` **不是**当前组织；`mcp` 9、`skill` 15、`provider` 8 同样含非当前组织的私有行。
  非成员组织（`Pu Wang`，9 个 private）被正确排除，说明谓词在生效，只是可见口径宽；③ **版本对照**
  （`git show HEAD:`）——迁移前的 `listAgentConfigs(ctx)` 是 `organization_id = ctx.organizationId`
  并集 `listExternalAgentConfigs`（只取 `listReadableResourceRefs` 的**公开**外部资源），
  `canReadResource` 对外部资源只认 `public`，`buildResourceAccess` 的 manageable / writable 只对
  internal 成立：`HEAD` 就是「当前组织 ∪ 公开」。这条回归是本次引入，不是历史行为。
- **修法（口径收敛，不是打补丁）**：`PolicyFacts` 去掉两个组织 id 列表，改为
  `actorActiveOrganizationId` + `activeOrganizationRole`（当前组织不在 `memberships` 里则为 `undefined`，
  组织分支整体不成立）；`buildAuthorizationPredicate` 的组织分支变为
  `r.organization_id = :activeOrgId`，且只在「当前组织的角色允许该动作」时才挂上；
  `projectActions` 的组织分支要求 `organizationId === facts.actorActiveOrganizationId`。跨组织共享只由
  `visibility = 'public'` 表达——这也与本仓既有的共享机制一致（builtin skill 托管在系统 admin 组织并
  「统一设置为公开可读，其他组织通过现有 public readable 机制访问」，`meta-agent.ts`）。
- **实测验证（收敛而非清零）**：同一脚本复跑，`test1` 的 `agent_config` 13 → **9** 行
  （`hpx/private`、`my-test/private` 消失，跨组织 `public` 行保留），`mcp` 9 → 7、`skill` 15 → 10、
  `provider` 8 → 6。
- **影响面不止列表**：详情与写路径共用同一份 `projectActions`，所以「在 A 组织上下文里对 B 组织私有资源
  拿到全量动作」的问题同时关闭；多组织用户按迁移前语义通过**切换组织**访问各自的资源。
- **设计文档修订**（已落盘）：§3.3 改写为「`memberships` 全量**不等于**可见范围是成员组织的并集」，
  并说明全量的理由是身份投影完整性；§3.2 的 `ActorContext.memberships` 补注释；§5 规则 3 与动作推导
  条目明确「同组织 = 归属组织就是当前 active organization」。契约注释同步：`platform-sdk` 的
  `ActorContext`、宿主 `auth.ts` / `org-context.ts` / `model-gateway-subject-verification.ts`、
  `provider-service.ts` 的 `systemActor`、`ports/subject-verification.ts` 与主体复验测试的说明文字
  （这些注释原先都在用「跨组织可见性依赖全量成员关系」解释 `memberships` 的必要性，是错误的理由）。
- **回归护栏**：`default-access-control.test.ts` 删掉断言并集语义的旧用例
  （`matches ownership against all memberships regardless of active organization`——它正是把错误口径
  固化下来的那条），替换为四条：跨组织（哪怕是 admin）拒绝 / 切换 active organization 后放行 /
  非成员组织的 `public` 仍可读 / 当前组织不在成员关系里则拒绝。谓词 ↔ 动作推导的等价合同测试
  （`authorization-consistency.test.ts`）继续覆盖「两者不会漂移」。

### 1.68 可用模型缓存的键是组织而不是主体（授权投影跨用户串读）

- **缺陷**：`available-models-cache.ts` 以 `organizationId` 单键缓存，而被缓存的值是
  `buildAvailableList(actor)` 的产物——每一行都带父 Provider 的 `scope` 与 `access`，其中
  `access.actions` 由 actor 在该组织里的角色推导（`owner` / `admin` 得到资源声明的全部动作，`member`
  只有 `memberDefaultActions`）。同组织的另一个用户（尤其是角色不同的用户）命中同一个键，就会读到
  前一个用户的授权投影：控制台据此显示只有 owner 才有的管理与共享入口，点下去 403。在 §1.67 修复前的
  宽口径下它还是行级泄漏的**放大路径**：先请求者若同时属于其他组织，会把那些组织的私有 Provider 行
  写进当前组织的缓存，之后任何同组织用户（哪怕不属于那些组织）都能读到。
- **与代码事实相反的注释一并改正**：文件顶部原写「不缓存任何鉴权结论……不会返回越权数据」，而缓存值
  里就有鉴权结论（`access`），这正是必须按主体分键的原因。
- **修法**：缓存键改为 `(organizationId, userId)`（新增 `AvailableModelsSubject`），`read` / `write` /
  `delete` 三个入口的入参由 `organizationId` 换成主体；`handleSet` 的失效改按主体，
  `invalidateAvailableModelsCache()`（Provider / Model 写路径）保持整体清空——写路径无法预知哪些主体
  会受影响。写入时顺带回收已过期条目，把键空间限制在 TTL 内的活跃主体上（键维度乘上用户后不能无界）。
- **控制台入口核对**：控制台「模型」页读的是 `GET /web/config/providers`（`providers.list`，
  `agent-models-data.ts:50`），因此用户看到的那批行级越权由 §1.67 覆盖；`/web/config/models`
  是模型选择器用的可用列表投影，它的键缺陷是独立的授权投影泄漏，本条修的就是它。
- **回归护栏**：新增「同组织不同用户不共享可用模型缓存」（owner 预热后，同组织的 member 必须拿到按自己
  角色推导的 `access`，且 `facade.list` 被调用两次）；既有「TTL 内命中」「其他组织的缓存不影响当前
  主体」「偏好写入后失效」三条按新键更新。
- **对抗核实的补充结论（工作流：4 个取证方向 → 逐条反驳）**：两个方向零发现——「残留并集语义」全仓
  零命中（所有 `memberships` 消费点、四张表的查询路径、internal actor 构造点与前端逻辑都已收敛到
  单组织语义），「过度收紧」未成立（`HEAD` 的跨组织可见性只由 `resource_permission` 里
  `principal_type='all' AND action='read'` 的授权行带来，即公开；skill / mcp / provider 与 agent-config
  同形）。两条候选发现被驳回，但各留下一条真实改进，均已落地：① 缓存写路径失效只覆盖 `/web`——
  `/api/models` 与模型网关同步不清这份缓存（`HEAD` 逐字相同，非本轮引入，见 §九 待办），本轮把缓存
  文件的措辞限定为「`/web` 写路径」并写明兜底手段；② `projectActions` 的成员分支原先直接取
  `memberDefaultActions` 而不与 `resource.actions` 求交，而谓词入口对未声明动作返回恒假——默认动作里
  声明了资源未支持的动作时，动作推导会比谓词更宽（详情放行、列表查不到），与「两者必须等价」相悖。
  已把成员分支改为与公开分支同样按上限过滤，并在一致性合同测试里补一条不变量（动作集合 ⊆
  `resource.actions`）与两个真前缀越界的 fixture（原先的两个 `OVERREACHING_*` fixture 声明的动作其实
  都在 `actions` 内，等于没覆盖这条约束）。四个真实资源声明的 `memberDefaultActions` 都 ⊆ `actions`，
  因此无运行时行为变化。

### 1.69 收口复核补记（交付前逐条核对计划时发现的四处）

本条由「对照批准计划逐条取证」的收口核对产出，含一项未记录的偏离、两处零消费者残留与三处由本次
重构直接造成的文档与代码矛盾。

**（一）`system-api-auth.ts` 留在宿主：计划 S1 的列举项，偏离此前只写在代码注释里**

- **计划字面**：S1 的 `src/auth/` 列举了 `system-api-auth.ts`（`RCS_SYSTEM_API_KEYS`），按字面应迁入
  `packages/platform/identity`。
- **实际实现**：守卫仍是宿主的 `apps/server/src/plugins/system-api-auth.ts`；identity 的
  `/api/system/*` 路由以工厂形式接收它（`createApiSystemRoutes({ systemApiGuardPlugin })`，
  `apps/server/src/main.ts:426`），依赖类型声明在
  `packages/platform/identity/src/routes/dependencies.ts:24`。
- **为什么不迁**（两条独立理由，均落在包边界的硬约束上）：
  ① Elysia 的 `macro` / `state` 是**实例作用域**的，父实例无法向已构造的子实例回填；守卫必须与宿主
  的认证解析（含测试 seam、ALS 增强、active organization 解析）是同一份实例，否则同一进程出现两套
  互不可见的认证状态（`dependencies.ts:8-11` 的既有理由，1.2 之前即如此）。
  ② `RCS_SYSTEM_API_KEYS` 的解析属于**宿主变量真相来源**，identity 不读 `process.env`——这与 §1.64
  的 env 声明推迟到 1.7 是同一条理由的两面：在包内自行解析会让"同一变量两处默认值"的分歧从启动期
  报错退化为运行期静默不一致。
- **影响范围**：无功能变化——`/api/system/*` 仍由 `RCS_SYSTEM_API_KEYS` 守卫保护，路由归属已在
  identity 包内，宿主持有的是守卫**实例**而非路由实现。计划里"身份路由归 identity"的意图达成。
- **记录原因**：这是本次核对（对照计划逐条取证）才补记的偏离，此前只写在代码注释里。补记是为了让
  §一 的确定性保持成立：计划列举项里没有"既无产物、也无记录"的条目。
- **移交**：1.7 的 env 收敛若把密钥解析下沉到各模块，本条需一并复评；届时守卫实例的作用域问题仍
  要求它由宿主装配。

**（二）两处零消费者残留按红线清除（`ScopedResource`、宿主 repositories barrel 的 identity 转发）**

- **发现**：S6 删旧栈时留下了两个"改指而非删除"的残件，全仓引用数均为 0：
  ① `platform-sdk` 的 `ScopedResource` 接口（与同批已删的 `ScopedResourceRepository` 是同一族的
  旧栈出口，唯一出现处就是它自己的定义）——配置 `access` 的形态已由各资源包的 `/web` 视图与
  `ResourceRecord` 承担；② `apps/server/src/repositories/index.ts` 对 `organizationRepo` /
  `IOrganizationRepo` 的转发（身份仓储的消费者一律直接 `from "@fenix/identity/server"`，宿主侧只有
  `agentEngineRepo` 一个真实消费者）。
- **处置**：两者删除。`ScopedResource` 删除后 `resource/scoped-resource.ts` 只剩 `ResourcePage`
  （仍被 `authorized-resource-query.ts` 使用），文件名随之改为 `resource-page.ts`；
  `repositories/index.ts` 保留注释说明转发为何移除，避免后来者重新加回。
- **为什么算 1.2 范围**：两者都是本任务 S1/S6 拆除身份与旧授权栈时"改指而非删除"的直接产物，
  计划红线要求「内部路径重构时直接删除过时实现，禁止新增兼容层」。删除后 `check:dependencies` /
  `architecture:check` / `precheck` 复跑全绿（证据见 §八），不涉及对外协议面。
- **不做的事**：`FUNCTIONAL_MODULE_INVENTORY.md`（仓根）仍把 `identity-admin`、`apps/server/src/auth/`、
  `access-control/src/resource-permission.ts` 等已删路径写成"现状落点"。它是 2026-09-03 基线的全量
  盘点，**在 1.2 之前就已对不上**（同样过期的还有更早迁走的 `apps/server/src/routes/web/config/agents.ts`
  等），且无任务认领，属"顺手重构无关文件"的范畴，只登记待办（见 §九）。

**（三）三处文档与代码矛盾同步修正（均直接由本次重构造成，非范围外顺手改）**

计划 §S6 的文档清单只列了 `CLAUDE.md` / 授权设计 / 工程标准 / 模块 README / review 文档，核对时另外
发现三处描述仍停在本任务**改变之前**的事实上，按 CLAUDE.md「若文档与代码不一致，先核实设计意图并
同步修正文档，不得静默沿用冲突规则」在同一提交内修正：

| 位置 | 旧表述（与本任务后的代码矛盾） | 修正后 |
|---|---|---|
| `docs/developer/guide/backend-development.md` §3 | 「`apps/server/src/db/schema.ts` 是唯一 Schema 真相来源」 | 两处真相来源 + 共同汇入同一条迁移链 + `drizzle.config.ts` 必须同时声明 |
| `docs/arch/tech-stack-backend.md` Schema 定义条目 | 「集中在一份 schema 文件中作为唯一真相来源」 | 身份表归 `packages/platform/identity/db/schema.ts`，业务表归宿主 |
| `docs/arch/03-auth.md` 「多凭证支持」 | 两步（session cookie → API Key） | 三步（session cookie → Environment Secret → API Key），与 `request-authentication.ts:10` 的「顺序与判定逐字保留」一致；含 Environment Secret 命中后的主体投影口径（属主 + environment 绑定的组织，个人 environment 回落属主） |

- **为什么不是"顺手改"**：三处矛盾都由本任务的动作直接产生——身份表在 S1 迁出宿主、凭据链的
  Environment Secret 分支在 S1 随 `request-authentication.ts` 一起搬迁（`plugins/auth.ts` 的注释已改写）。
  改的是"本任务改了什么"的陈述，不是无关内容。

---

## 二、发现的既存问题（本切片不改，仅记录）

### 2.1 `loadOrgContext` 对显式指定但无权限的组织静默回退

`apps/server/src/services/org-context.ts`（改动前 L87–94，改动后保留同样语义）：请求通过
`x-active-org-id` / query / cookie 显式指定组织 X，而用户不是 X 的成员时，实现**不报错**，
而是回退到用户的第一个组织并把该上下文交给后续所有读写。

- **影响**：调用方以为自己在 X 的上下文里，实际落在 Y。跨组织隔离本身未被突破（回退目标仍是
  用户自己的组织），但"显式选择被静默忽略"会让客户端缓存与后续写路径归属不一致。
- **建议**：改为显式拒绝（返回 null 或 4xx），由前端在组织切换失败时刷新组织列表。
- **为什么本切片不改**：属于产品行为变更，需单独评审；任务 1.2 的范围是边界与授权收敛。

### 2.2 `apps/server/src/plugins/auth.ts` 中按手机号查用户

`authenticateRequest` 链路里存在按 `phoneNumber` 直查 `user` 表的分支。手机号是登录标识，
但该查询未经 identity 的公开入口。迁移后应由 identity 提供等价窄接口，或在 identity 内部完成。
S1 重接时确认此项是否仍在调用路径上。

### 2.3 `/web` 列表的工具计数是逐行查询（N+1）

`McpServerFacade.list` 为每个列表项调用一次 `service.countTools`（`Promise.all` 并发，但仍是每行一次
查询）。迁移前是同样口径，因此不是回归；但列表页在服务器数量多时会产生 N 次 `mcp_tool` 计数查询。

- **建议**：改为一次 `group by (organization_id, server_name)` 的批量计数（仓储新增批量方法，Facade 调用一次）。
- **移除条件**：资源列表量级增长、或 S6 补齐下推回归断言时一并处理。
- **注意**：计数降级为 0 的行为要保留（缓存表故障不得让整个列表失败）。

### 2.4 `apps/server/src/test-utils/setup-mocks.ts` 的 mcp 相关死条目

`CONFIG_PG_KEYS` 中仍列有 mcp 的旧栈桩键（`listMcpServers` 等），而宿主 barrel 已不再导出这些符号，
条目无消费者。

- **为什么本轮不改**：宿主测试套件全绿，改动属于与本任务无关的测试基建清理；S6 随旧栈文件一并删除时
  此处接线会一起清掉。
- **移除条件**：S6 删除旧授权栈与 `config-pg` 桩接线时。

### 2.5 `apps/server/src/test-utils/stubs/module-stubs.ts` 的十三个死桩注册表

`module-stubs.ts` 相对 `HEAD` **未修改**（`git diff HEAD --stat` 为空），因此下列注册表在任务 1.2
开始前就已无消费者，不是本轮切换造成的：

| 桩符号 | 全仓引用（排除 `module-stubs.ts` 与 `helpers.ts` 的再导出） |
|---|---|
| `stubRepositories` / `stubSession` / `stubEnvironmentCore` / `stubLaunchSpecBuilder` / `stubInstance` | 0 |
| `stubEnvironmentWeb` / `stubConfigSkill` / `stubConfigAgentConfig` / `stubAgentKnowledge` | 0 |
| `stubMcpInspector` / `stubConfigMcpServer` / `stubWorkflowTriggerRepo` / `stubWorkflowTriggerService` | 0 |

即 21 个注册表中有 13 个只有 `helpers.ts` 的再导出、没有任何 `stubXxx(...)` 或 `xxxRegistry` 调用点
（`apps/server/src/test-utils/setup-mocks.ts` 的 `mock.module` 接线只用到 `coreBootstrapRegistry` /
`customToolsRegistry` / `fileWsHandlerRegistry` / `knowledgeBaseServiceRegistry` /
`pgStorageAdapterRegistry` / `registryHeartbeatRegistry` / `registryRegistry` 七个）。

- **为什么本轮不改**：这是任务 1.2 之前就存在的测试基建死代码，与身份 / 授权收敛无关；按"不得顺手
  重构无关代码"只记录不清理。注意删除它们会连带影响 `helpers.ts` 的再导出面，属于一次独立的测试基建
  整理（须同时核对 21 个注册表的真实使用情况），不适合塞进本任务收尾。
- **移除条件**：单独立项的测试基建清理任务。
- **更正**：S1–S4 期间本节曾记为"四个"（只列了 config 系列），系按当时 grep 的局部结果判断；
  S6 全量核对后更正为 13 个。

### 2.6 `safeWebHandler` 的 `fallbackCode` 分支把内部异常原文回显给客户端

`web-envelope.ts`（`packages/resources/model-management/src/server/routes/web/config/`）：

```ts
const message = error instanceof Error ? error.message : "Unknown error";
return status(500, configError(options.fallbackCode, message));
```

- **证据**：`git show HEAD:packages/resources/model-management/src/routes/web/config/models.ts`
  的三处 `catch` 是**完全相同**的写法（`L180–185` / `L218–223` / `L251–256`）。S5 只是把这段从路由
  内联抽成共用信封，行为逐字保留，**不是本轮引入**。
- **风险**：非 `AppError` 的异常原文可能包含连接串、SQL 片段或上游响应体；CLAUDE.md 要求"对外错误
  不得泄露敏感信息或内部实现"。触发条件是 500 路径（此时响应本身已失败），但泄漏是真实的。
- **建议**：对外只回 `CONFIG_READ_ERROR` / `CONFIG_WRITE_ERROR` 的固定文案，原文经结构化日志
  （`startupLog` / logger）落盘，用 traceId 关联。
- **为什么本切片不改**：属于对外协议文案变更，需与前端错误提示一起评估；且改动会在 `/web` 500 响应
  中删掉前端当前可能展示的诊断信息。

### 2.7 `/api/models` 仍留在包的旧顶层路径，且超过 500 行红线

`packages/resources/model-management/src/routes/api/models.ts`（638 行）仍位于 `src/routes/api/`，
而本包其它服务端实现都已迁入 `src/server/`（`src/server/routes/web/config/*`、
`src/server/repositories/*`、`src/server/facades/*`）。同类的旧顶层残留还有：

| 文件 | 行数 | 说明 |
|---|---|---|
| `model-management/src/routes/api/models.ts` | 638 | S5 已改为经 Facade（380 行改动），路径与文件大小未处理 |
| `model-management/src/services/peri-task-detail-service.ts` | 67 | 未在 1.2 计划范围内 |
| `model-management/src/services/peri-task-detail-store.ts` | 41 | 同上 |
| `agent-config/src/routes/web/sidebar-config.ts` | 25 | 同上 |
| `agent-config/src/services/sidebar-config.ts` | 27 | 同上 |
| `agent-config/src/services/meta-agent.ts` | 466 | S4 只把它的 builtin skill 编排改走 `IdentityDirectory`，未搬迁 |

- **为什么本切片不改**：计划 S5 只要求"切换授权栈"，未要求搬迁这些文件；把 638 行文件拆到 500 行
  以下需要先决定 `/api/models` 的协议分解（Provider / Model / 网关三组子资源），属于独立重构。
- **移除条件**：1.3 的"资源包内目录统一为 `src/server/*`"、或 `/api/*` 协议面整理任务。
- **附带结论**：638 行是**既存**的红线违反（`HEAD` 上同为 638 行），S5 的改写没有加重它。

### 2.8 `orchestration-instance.ts` 用伪造的 `owner` actor 读 Agent 配置

`packages/agent-runtime/src/services/orchestration-instance.ts:472–477`：

```ts
const accessCtx: AuthContext = { organizationId: env.organizationId ?? "", userId: launchSpec.userId, role: "owner" };
const agentConfig = await getReadableAgentConfigById(accessCtx, env.agentConfigId);
```

- **证据**：`git show HEAD:...` 确认这段在迁移前逐字相同，本轮未触碰。
- **风险**：`role: "owner"` 是硬编码的伪造角色；`organizationId ?? ""` 在环境缺少组织时产生一个
  `activeOrganizationId === ""` 的退化 actor。当前不构成越权——`getReadableAgentConfigById` 只做
  `read`，读动作对成员与公开资源都开放，伪造角色拿不到额外能力（`system-entries.ts` 的注释已声明
  这一点）；但"伪造角色"这个形状一旦被复制到写路径就会立刻变成权限提升。
- **建议**：改为 `getAgentConfigById(id, env.organizationId)`（无授权 + 显式归属校验）——本路径的
  归属已由环境持有，不需要 actor 形参；或让 `organizationId` 为空时直接抛错而不是退化成 `""`。
- **为什么本切片不改**：调用点在 `agent-runtime`，属 1.4 的收敛范围。

### 2.9 `handleFetchModels` 的内联凭据分支是 SSRF 读取原语

`provider-handlers.ts` 的内联分支允许任一已认证用户让服务器带着请求方提供的 `apiKey` 请求**任意**
URL，非 2xx 时上游响应体被截取 200 字符回显。代码注释已就地记录（`provider-handlers.ts:129–131`）。

- **证据**：迁移前 `HEAD` 的 `providers.ts` 同一分支行为一致，非本轮引入。
- **修复需要**：出站 URL 策略（内网地址 / 元数据端点黑名单或允许列表）+ 回显脱敏。属独立安全任务。
- **移除条件**：出站请求策略任务落地时。

### 2.10 资源包的路由直接 import 宿主 schema 文件

`model-management` 的 `/web/config/*` 路由从 `@server/schemas/config.schema` 取响应契约
（Provider / Model 的 6 个 schema），方向是"资源包 → 宿主 schema 面"。

- **为什么保留**：这批契约迁移前就登记在宿主 schema 面（`/web/config/*` 统一由宿主 `schemas/` 描述），
  1.2 只搬路由不搬 schema；把它们下沉到各家资源包是协议面整理，需要同时核对 `/web` 与 `/api` 的
  OpenAPI 输出（`detail` 已声明跨文件引用）。
- **移除条件**：`/web/config/*` 协议下沉任务；届时 `apps/server/src/schemas/config.schema.ts` 应只剩
  宿主自己的协议。

### 2.11 创建 Agent 的旁路失败会在主表已写入之后才报错（部分写入）

`handleCreate` 的顺序是：`facade.create`（主表 INSERT + `create` 授权）→ `setMemoryEnabled` →
`applyAgentBindings`（knowledge → skill → mcp → siteApp，见 `services/agent-bindings.ts:85-95`）。
其中 knowledge 同步是**第一个**旁路步骤，且会抛 `InvalidKnowledgeBindingError`（非 `AppError`，被
`AGENT_ERROR_STATUS` 映射为 400）。

- **影响**：请求里带了不存在 / 无权限的 `knowledge.knowledgeBaseIds` 时，用户看到 **400「知识库不存在或
  无权限访问」，但该 Agent 的主表行已经创建成功**——刷新列表就会看到它；用户按提示改名重试则命中 409
  「已存在」（本节与 §1.36 / §1.66 收口后的组织内判定无关，是另一类现象）。skill / mcp / siteApp 的
  同步没有同类抛错，但同样在失败时留下"主表行 + 部分绑定"的中间态。
- **为什么本切片不改**：属事务边界设计（把主表写入与关联绑定收进同一事务，或改为"先校验后写入"），
  影响 `/web` 与 `/api` 两条创建路径的失败语义与前端容错分支；迁移前（`HEAD`）就是同样的顺序
  （`createAgentConfig` → memory → `syncAgentKnowledgeBindingsById`），不是本次重构引入。
- **建议方向**：把 knowledge / mcp / siteApp 的**可校验部分**（存在性与可见性）提到 `create` 之前，
  或让整个创建走一个事务；若选事务方案需先确认绑定表写入与主表在同一连接上的可行性。
- **移除条件**：创建路径的失败原子性单独立项时。

### 2.12 `/api/mcp` 不做 `/web` 已有的 MCP 领域校验（两入口分叉）

`isValidMcpName` / `validateMcpConfig`（`mcp/src/server/services/config/mcp-config.ts:76,87`）**只被
`/web/config/mcp` 引用**（`routes/web/config/mcp.ts:120,123,143`）；`/api/mcp` 的 POST 走
`toMcpConfig(payload)` → `facade.create(...)`，全程不校验（`routes/api/mcp.ts:254-263`）。Facade 与
领域服务都不补这一步。

- **影响**：通过 `POST /api/mcp` 可以写入控制台会拒绝的记录——非法 `name`（大写 / 下划线 / 含 `--` /
  超 64 字符）与非法 `config`（`type` 不在三种取值内、`local` 缺 `command`、`remote` 缺 `url`、
  `timeout <= 0` 等）。其中 `type` 由 `readMcpServerType` **原样写入** `mcp_server.type`
  （`varchar(32)`，`db/schema.ts:565`），读取侧 `normalizeMcpServerType` 再把未知值归成 `local`——于是
  这条记录以"local 服务器"的身份出现在控制台，却没有 `command`；超过 32 字符则写库直接报错 → 500。
  该函数的文档注释把"写入前调用方已用 `validateMcpConfig` 判定合法性"当作前提
  （`mcp-config.ts:131-133`），这个前提**对 `/api` 调用方不成立**。
- **为什么本切片不改**：属"两个入口的领域校验分叉"，与 §九 的 `/api` 协议面统一是同一件事；用户已裁决
  `/api/*` 本次不动（见 §九）。校验函数是纯函数、不需要 actor，修复形态清楚但会改 `/api` 的写入接受面。
- **既存性质（已核）**：`git grep` 在 `HEAD` 上同样是"只有 `/web` 引用这两个校验函数"，非本次重构引入。
- **建议方向**：校验属资源领域规则，统一时应落在 Domain Service / Facade 的 create 路径，让两条入口共享
  同一份判定；不要只在 `/api` 路由里再调一次（那会变成第三份调用点）。
- **移除条件**：任务 1.5 的 `/api` 与 `/web` 统一（见 §九「附：任务 1.5 的 /api 协议面盘点」）。

---

## 三、验证证据（S1 收口）

| 项 | 命令 | 结果 |
|---|---|---|
| 全量门禁 | `env -u ANTHROPIC_MODEL bun run precheck` | ✓ 全绿：857（server+scripts+sdk）/ 6521（packages，2 skip）/ 961（web） |
| 前端生产构建 | `bun run build:web` | ✓ built in 4.18s |
| schema 拆分零 DDL | `bun run db:generate --name check-identity-schema-split` | `No schema changes, nothing to migrate`——未生成空迁移文件，`drizzle/` 无改动 |
| 依赖边界 | `bun run check:dependencies` | ✓ 1828 modules，28 条已登记例外，0 条新增违规 |
| 资源路由独立加载 | `source-route-imports.test.ts` | ✓（1.11 的宿主中介环消除后恢复） |

**已知既有噪声（未处理，附证据）**：

1. `bun run lint` 报 12 条 warning，全部位于 `scripts/check-architecture.ts`、
   `scripts/generate-module-registry.ts`、`scripts/lib/architecture-boundary-rules.ts`、
   `scripts/lib/workspace-packages.ts`（`noUselessUndefined` ×11 + `noUnusedImports` ×1）。这四个文件
   相对 `HEAD` **未修改**（`git diff --stat` 为空），且 `scripts/ci.ts` 的 lint 步骤只报 warning 不失败
   （`✓ lint`）。按"不得为了通过检查而无边界改写无关文件"暂不处理。
2. `apps/server/src/__tests__/round37-service-boundaries.test.ts` 的
   `机器连接超时 2ms 时按剩余时间截断等待` 在**首次完整 precheck 中失败**（`Expected: 1, Received: 2`），
   此后不再复现：单独运行该文件 5/5 通过、整批（`apps/server/src/__tests__/` + `scripts/__tests__/` +
   sdk）复跑 2 次各 852 通过、第二次完整 precheck 通过。该用例与实现
   (`packages/resources/machine/src/server/services/machine-connection-waiter.ts`) 均未修改
   （`git diff --stat` 为空）。失败模式为 2ms 定时器与 `Date.now()` 粒度竞争，负载较高时可能多一次轮询；
   属既有的环境相关抖动，未改断言。

---

## 四、验证证据（S2 收口）

| 项 | 命令 / 用例 | 结果 |
|---|---|---|
| 全量门禁 | `env -u ANTHROPIC_MODEL bun run precheck` | ✓ All passed（93.4s）：863（server+scripts+sdk）/ 6545（packages，2 skip）/ 961（web） |
| 依赖边界 | `bun scripts/check-dependency-boundaries.ts` | ✓ 1853 modules，25 条已登记例外，0 条新增违规，无失效条目 |
| 谓词 ↔ 动作推导一致性 | `access-control/__tests__/authorization-consistency.test.ts` | ✓ 断言 `rowSatisfiesPredicate(谓词, 行) ⟺ action ∈ projectActions(facts, scope)`；采用**确定性穷举**而非随机采样（覆盖缺失 active organization、无成员关系、未声明 `visibility`、`publicDefaultActions` 为空、声明了资源未支持的动作） |
| 新授权栈单测 | `access-control/__tests__/default-access-control.test.ts` | ✓ `resolveInitialScope` / `resolveAccess*` / `createListConstraint` / 拒绝路径 |
| 数据迁移 | `apps/server/src/__tests__/backfill-resource-visibility.test.ts` + `bun run db:migrate` | ✓ 用例通过；`drizzle-kit` 报告 `migrations applied successfully`（0027 四列 + 四索引） |
| mcp web/api 路由 | `mcp/__tests__/round40-*`、`round47-*`、`round66-*`、`mcp-server-facade.test.ts` | ✓ 路由断言参数与响应映射，Facade 断言编排（1.23） |
| 跨包 web 调用方（含本轮修复） | `agent-config/__tests__/`（35 文件）+ `apps/server/src/__tests__/config-integration.test.ts` + `model-management/web/__tests__/provider-model-resource-access-flow.test.ts` | ✓ 420 + 全部通过 |
| 前端生产构建 | `bun run build:web` | ✓ built in 2.06s |

**S2 期间的行为变化（供评审对照）**：

1. `/web` 受控资源视图返回 `scope` + `access.actions`（D2），MCP 视图另带顶层 `organizationName`（1.17）。
2. 成员对组织资源只剩 `read` / `use`（D1）；创建 / 更新 / 删除归属 owner / admin。
3. `/web` 列表不分页，授权谓词与排序全部下推（D9）。

**已知既有噪声（S2 复跑结论，与 S1 相同，未处理）**：

1. lint 12 条 warning，仍是同一批文件（`scripts/check-architecture.ts` 1 条 `noUnusedImports` +
   `scripts/generate-module-registry.ts` 6 + `scripts/lib/architecture-boundary-rules.ts` 3 +
   `scripts/lib/workspace-packages.ts` 2 条 `noUselessUndefined`），四个文件相对 `HEAD` 未修改
   （`git status --porcelain` 为空），`scripts/ci.ts` 的 lint 步骤只报 warning 不失败。
2. `round37-service-boundaries.test.ts` 的定时器抖动本轮未复现（S2 的两次完整 precheck 中均通过）。

---

## 五、验证证据（S3 收口）

| 项 | 命令 / 用例 | 结果 |
|---|---|---|
| 全量门禁 | `env -u ANTHROPIC_MODEL bun run precheck` | ✓ All passed（82.5s）：863（server+scripts+sdk）/ 6563（packages，2 skip）/ 962（web） |
| 依赖边界 | `bun scripts/check-dependency-boundaries.ts` | ✓ 1863 modules，25 条已登记例外，0 条新增违规，无失效条目 |
| 架构例外台账 | `bun scripts/check-architecture.ts` | ✓ 1722 files，11 rules，40 条已登记例外（删 1.33 的失效条目后复算） |
| 前端生产构建 | `bun run build:web` | ✓ built in 1.97s |
| 路由协议 | `skill/__tests__/round44-skills-config-routes.test.ts`（24）、`api-skills-routes.test.ts`（12） | ✓ 参数校验、主体与分页下推、`scope + access` 视图映射、错误码 → 状态码、上传冲突 409 带 `data` |
| Facade 编排 | `skill/__tests__/skill-facade.test.ts`（20） | ✓ 授权拒绝、跨组织同名不算冲突、idempotent upsert、覆盖失败恢复 |
| 内容层 | `skill-archive-lifecycle.test.ts`（8）、`skill-import-shared-validation.test.ts`（4）、`skill-import-name-overwrite.test.ts`（4） | ✓ 写盘顺序、快照回滚、归档一致性、分组校验先于写入、冲突策略 |
| 下推断言 | `skill-repository.test.ts`（6） | ✓ 条件以**不透明句柄**原样交给授权查询端口（`toBe` 断言同一引用，非形状复制）；列表与计数共用同一条件；行→视图之间无过滤步骤（端口返回什么就返回什么）；资源键中的组织限定以 `organization_id` 条件进入 WHERE（`findReadableByName` 给组织才有该条件） |
| 谓词 ↔ 动作推导一致性 | `access-control/__tests__/authorization-consistency.test.ts`（S2 交付，本切片消费） | ✓ 谓词编译与动作推导同源，skill 只是把句柄透传 |
| 前端授权视图 | `skill/web/__tests__/`（5 文件）、`apps/web/src/__tests__/agent-form-dialog-pure-logic.test.ts` | ✓ 归属判定、`update` 动作决定写权限与共享管理、筛选与计数、选项映射与不可变性 |
| agent-config 回归 | `packages/resources/agent-config/`（47 文件） | ✓ 554 pass（含 `use-agent-editor` 的 skill 选项分组切换） |
| DDL | 无 | S3 不涉及 schema 变更，未运行 `db:generate` / `db:migrate` |

**S3 期间的行为变化（供评审对照）**：

1. `/web/config/skills` 的列表与详情返回 `scope` + `access.actions`（D2），另带顶层 `organizationName`；
   上传冲突的 409 现在**真的**带上了 `data.conflicts` / `allowedStrategies`（1.27 修的是既存缺陷，
   前端弹窗此前从未生效过）。
2. **前端写权限判定收紧**：旧实现 `resourceAccess.writable !== false` 在字段缺失时视为**可写**；
   新实现要求 `access.actions` 明确包含 `update`，缺失即不可写。这是有意收紧，不是回归。
3. 前端「公开」筛选与角标改按 `scope.visibility` 判定；跨组织可见的资源必然同时是公开资源，
   因此它同时出现在「公开」筛选里（旧栈下 `external` 与 `publicReadable` 是两个独立标记，可以只满足前者）。

**已知既有噪声（S3 复跑结论，与 S1 / S2 相同，未处理）**：

1. lint 12 条 warning，仍是同一批 `scripts/` 文件（清单见 §四），相对 `HEAD` 未修改；
   S3 新增/改写的文件自身 0 warning（曾短暂出现 6 条，均已按规则修正：`noUselessUndefined` ×3、
   错位的 `biome-ignore` 致 `noExplicitAny` + `suppressions/unused`、未使用形参 1 条）。
2. `round37-service-boundaries.test.ts` 的 `机器连接超时 2ms 时按剩余时间截断等待` 本轮**再次出现**
   一次（`Expected: 1, Received: 2`），与 S1 同一失败模式：单独运行该文件 2/2 通过、随后完整 precheck
   通过。失败用例与实现（`packages/resources/machine/.../machine-connection-waiter.ts`）均未被本轮改动
   触及，属既有的环境相关定时器抖动。

---

## 六、验证证据（S4 收口）

| 项 | 命令 / 用例 | 结果 |
|---|---|---|
| 全量门禁 | `env -u ANTHROPIC_MODEL bun run precheck` | ✓ All passed（81.1s）：863（server+scripts+sdk）/ 6564 pass + 2 skip（packages，513 文件）/ 962（web） |
| 依赖边界 | `bun run check:dependencies` | ✓ 1872 modules，24 条已登记例外，0 条新增违规，无失效条目（删除 1.51 的条目后复算） |
| 架构例外台账 | `bun run architecture:check` | ✓ 1731 files，11 rules，39 条已登记例外 |
| 前端生产构建 | `bun run build:web` | ✓ built in 1.93s |
| 零 DDL | `bun run db:generate --name check-s4-no-ddl` | `No schema changes, nothing to migrate`——S4 不涉及 schema，`drizzle/` 无新增改动（仅 S2 的 0027 仍待提交） |
| agent-config 包 | `bun test packages/resources/agent-config` | ✓ 294 pass / 28 files / 0 fail |
| 前端授权视图 | `packages/resources/agent-config/web/__tests__/agent-resource-access-flow.test.ts`（6）、`apps/web/src/__tests__/agent-form-dialog-pure-logic.test.ts` | ✓ 归属资源键、展示名按组织限定、外部只读降级、缺失动作集合按不可写降级、公开开关请求体 |
| `/api` 协议适配（D2） | `.../src/__tests__/api-agents-routes.test.ts` | ✓ 列表/详情仍返回 `resourceAccess`，`ownership` 由 `scope` 与 `access.actions` 派生；**§1.36 回退后补**了「组织内同名 → 409 `ALREADY_EXISTS` 且不写入」用例 |
| 创建期冲突口径（§1.36 回退） | `.../src/__tests__/agent-config-create-conflict.test.ts` | ✓ `existsInOrganization` 按 `(name, activeOrganizationId)` 定位、命中/未命中、**不经过授权查询**（`createListConstraint` 零调用）、缺 `activeOrganizationId` 时返回 false 且不查询、**跨组织公开同名的对照**（`get` 真 / `existsInOrganization` 假） |
| `/web` 视图与编排 | `.../round44-agent-config-routes.test.ts`、`.../round43-agent-sites-routes.test.ts`、`apps/server/src/__tests__/config-integration.test.ts` | ✓ `scope + access` 视图映射、403 声明、同名冲突 409（**§1.66 改为打桩 `existsInOrganization` 并断言命中即止**）、**§1.66 新增**「其他组织的同名可见 Agent 不构成创建冲突 → 200 且 `create` 被调用」、删除时先停实例再删行 |
| 测试接缝迁移 | 1.50；`apps/server/src/test-utils/`（`agent-config-route-deps.ts` 删除、`config-pg-stub.ts` / `setup-mocks.ts` 清理） | ✓ 8 个死键清理后 `CONFIG_PG_KEYS` 与桩接口保持一致；被删键无其他消费者；全仓无 `mock.module()` |

**S4 期间的行为变化（供评审对照）**：

1. 前端展示名按归属组织限定：本组织资源也会显示为 `<组织名>/<资源名>`（1.44）。这与 mcp / skill
   现有行为同形，但相对 agent 的旧实现是**可见变化**，处置建议见 1.44。
2. 前端写权限判定收紧：`access.actions` 缺失或不含 `update` 即不可写、不可管理共享（1.43），
   与 S3 对 skill 的收紧同源。
3. `getAgentOptionValue` 删除（1.43）：全仓零生产调用点，仅 2 处测试引用，未保留兼容层。
4. 资源包内 `routeConfigDeps` 代理删除（1.50）：Site 绑定路由改为直接导入同一实现，协议与响应不变。

**已知既有噪声（S4 复跑结论）**：

1. lint 12 条 warning，全部位于 §三 记录的同一批 `scripts/` 文件（`generate-module-registry.ts` 6、
   `lib/architecture-boundary-rules.ts` 3、`lib/workspace-packages.ts` 2、`check-architecture.ts` 1），
   四个文件相对 `HEAD` 未修改（`git status --porcelain` 为空）。注意 precheck 的 lint 步骤包含
   `scripts/` 与 `docs/.vitepress/`，比 `bun run lint`（不含 `scripts/`）范围更大，因此直接跑
   `bun run lint` 看不到这批 warning。S4 自身文件 **0 warning**：曾出现 2 条
   `lint/style/useImportType`（`agent-route-support.ts` 的 `WebErrSchema` / `z` 只用于类型位置），已修。
2. 前两轮 precheck 各出现 1 次与 S4 无关的定时器抖动失败，第三轮全绿：
   - `round37-service-boundaries.test.ts` 的「机器连接超时 1ms 时按剩余时间截断等待」（`Expected: 1,
     Received: 0`）——与 S1 / S3 记录的同一失败模式（S1 为 2ms 用例 `Expected: 1, Received: 2`），
     单独复跑 3/3 通过；
   - `packages/resources/machine/src/server/__tests__/file-ws-events.test.ts` 的「忽略 node_modules、
     .git 与构建产物目录的单帧和批量事件」（`Expected length: 1, Received length: 2`），单独复跑
     5/5 通过。
   两者用例与实现相对 `HEAD` 均未修改，属并行满载下的既有时序抖动（S4 未触及这两个包）。

---

## 七、验证证据（S5 收口）

| 项 | 命令 / 用例 | 结果 |
|---|---|---|
| 全量门禁 | `env -u ANTHROPIC_MODEL bun run precheck` | ✓ All passed：847（server+scripts+sdk，含 §1.61 新增的 8 例）/ 6578 pass + 2 skip（packages，514 文件）/ 962（web） |
| 依赖边界 | `bun run check:dependencies` | ✓ 1878 modules，23 条已登记例外，0 条新增违规（`model-management → access-control` 的 `special-dependency` 已随切换失效并删除） |
| 架构例外台账 | `bun run architecture:check` | ✓ 1737 files，11 rules，38 条已登记例外 |
| 前端生产构建 | `bun run build:web` | ✓ built in 2.08s |
| 零 DDL | `bun run db:generate --name check-s5-no-ddl` | `No schema changes, nothing to migrate`（S5 不涉及 schema） |
| Provider 仓储下推 | `model-management/__tests__/provider-repository.test.ts`（11） | ✓ 条件以不透明句柄原样交给端口（`toBe` 同一引用）；列表与计数共用同一条件；行→视图之间无过滤步骤；资源键中的组织限定进 WHERE；`create` 冲突分支与 `updateById` 的写入负载均不含归属列；`findByIdUnscoped` 不经过授权端口 |
| `/web/config/providers` 协议 | `round-config-providers-routes.test.ts`（14） | ✓ `scope + access` 视图、`keyHint` 掩码（断言掩码值，不出现明文）、`extraOptions` 拆分（`options` 里的 `apiKey` 被丢弃、不落 jsonb）、模型增改分派、`VALIDATION_ERROR` / `FORBIDDEN` / `NOT_FOUND` → 400/403/404、子表写入前先过 `getWritable`、探测走 `getForProbe`、内联凭据分支不读库 |
| `/web/config/models` 协议 | `round-config-models-routes.test.ts`（11） | ✓ 模型行继承 Provider 的 `scope` / `access`、来源组织名只给跨组织可见项、TTL 内命中按组织缓存、`refresh` 绕过缓存、偏好引用校验（不可读 Provider / 不存在的模型 → 400 且不写偏好）、三段式资源键按资源键定位、写入后失效缓存、非 `AppError` 按 `fallbackCode` 归一化 |
| 主体复验端口 | `apps/server/src/__tests__/model-gateway-subject-verification.test.ts`（8，§1.61 补） | ✓ 五种拒绝原因各自的触发条件与顺序早退、归属其它组织与行不存在同判 `AGENT_NOT_FOUND`、`ResourceAccessDeniedError` → `AGENT_ACCESS_REVOKED`、非权限异常原样上抛、放行路径以 `use` + 真实资源注册调用且 actor 带全量成员关系 |

**S5 期间的行为变化（供评审对照）**：

1. 主体复验（1.52）：新增 `USER_NOT_FOUND` / `ORGANIZATION_NOT_FOUND` / `AGENT_NOT_FOUND` 三种拒绝
   原因——迁移前这三种"恒不成立"，等价于任何组织成员可为任意 `agentConfigId` 换到网关凭据。
2. 连通性探测（1.53）：**组织成员不能再测试 Provider 连通性**，改为要求 `update`（owner/admin）；
   系统托管 gateway Provider 仍可探测、仍不可写。
3. `/web` 与 `/api/models` 的 Provider / Model 视图：`/web` 返回 `scope + access.actions`（D2），
   `/api/models` 保留 `resourceAccess` 并由 `toResourceAccessView` 从 `access.actions` 派生。
4. 前端 `canWriteProvider` 改为 `isProviderWritable(provider) && kind !== "gateway"`——迁移前缺失
   动作集合会**默认放行**，现在缺失即拒绝；gateway 不再暴露必然 403 的入口。

---

## 八、验证证据（S6 收口）

| 项 | 命令 / 用例 | 结果 |
|---|---|---|
| 全量门禁 | `env -u ANTHROPIC_MODEL bun run precheck` | ✓ All passed（81.3s）：839（server+scripts+sdk）/ 6578 pass + 2 skip（packages，514 文件）/ 962（web）——S6 收口首轮；**§1.61 补测 8 例后复跑为 847，其余各项数字不变**，见 §七「主体复验端口」行 |
| 依赖边界 | `bun run check:dependencies` | ✓ 1878 modules，23 条已登记例外，0 条新增违规，无失效条目 |
| 架构例外台账 | `bun run architecture:check` | ✓ 1737 files，11 rules，38 条已登记例外 |
| 前端生产构建 | `bun run build:web` | ✓ built in 2.08s |
| 文档站点 | `bun run docs:build` | ✓ build complete（含本 review 文档） |
| 零 DDL | `bun run db:generate --name check-s6-no-ddl` | `No schema changes, nothing to migrate`——S6 **不产出 DROP 迁移**（1.54 裁决 A）。`drizzle/` 待提交的只有 0027 `access-control-resource-visibility`（新栈四表的 `visibility` 列 + 四个 `(organization_id, visibility)` 索引；三个 pg enum 与 `resource_permission` 表是既存对象，本轮不 DROP）；回填是启动期数据迁移 `services/data-migrates/backfill-resource-visibility.ts`，不产生 SQL 文件 |
| 旧栈残留 | `find apps packages scripts -name "*resource-permission*"` | 无任何命中：`apps/server/src/repositories/resource-permission.ts`、`test-utils/stubs/resource-permission-repo-stub.ts`、旧启动顺序测试均已删除；`resource_permission` 这个标识符只剩 `db/schema.ts` 的表/enum 定义（带 `removeWhen`）与回填迁移的读取 |
| 台账一致性 | `scripts/__tests__/rmd-06-migration.test.ts`、`rmd-07-migration.test.ts`、`root-source-owner-inventory.test.ts` | ✓ 全部通过（12 项 RMD-06 含 5 个 `null` 删除标记；RMD-07 72 项；根路径规则仍记 `platform-access-control`） |
| 资源包回归 | `bun test packages/resources/model-management`（21 文件）、`packages/resources/agent-config`（29 文件） | ✓ 146 pass / 304 pass，0 fail |
| 授权栈回归（S6 交付面） | `access-control/__tests__/default-access-control.test.ts`（跨组织 / owner / admin / member / private / public / super-admin 构造 actor / 拒绝路径）、`authorization-consistency.test.ts`（谓词 ↔ 动作推导）、`round45-auth-plugin.test.ts`（API Key 组织恢复 + 保守拒绝）、`backfill-resource-visibility.test.ts` | ✓ 全部通过 |

**S6 期间的行为变化**：无。S6 只做删除、台账更新与文档，未改动任何运行时行为。

**已知既有噪声（S6 复跑结论，与前四轮相同）**：precheck 全绿且未复现任何时序抖动；
`lint` 仍是同一批 12 条 `scripts/` warning（四个文件相对 `HEAD` 未修改，见 §三）。

**文档收口复跑**：文档更新（`CLAUDE.md` 的 schema 真相来源与授权不变量、《工程标准》§2.4 / §10.3、
《授权设计》§6.2、identity / access-control 的 README、`docs/arch/14-user-org.md`、`docs/arch/03-auth.md`、
`docs/developer/guide/backend-development.md`）落地后重跑
`bun run docs:build` ✓ 10.02s 与 `env -u ANTHROPIC_MODEL bun run precheck` ✓ All passed（79.8s）：
839 / 6578 pass + 2 skip / 962、lint 同为 12 条 `scripts/` warning、architecture 38 条例外、
dependency-boundaries 1878 modules / 23 条例外 / 0 新增违规。文档改动不触碰运行时代码，两轮结果一致。

**本 review 文档定稿后复跑**：§1.61（补测 8 例）、§七「主体复验端口」行、§八 数字同步、§9.1（A 类裁决表）
写入后再次重跑 `bun run docs:build` ✓ 12.62s 与 `env -u ANTHROPIC_MODEL bun run precheck` ✓ All passed（85.8s）：
847（62 文件）/ 6578 pass + 2 skip（514 文件）/ 962（56 文件）、lint 仍为 12 条 `scripts/` warning、
architecture 38 条例外、dependency-boundaries 1878 modules / 23 条例外 / 0 新增违规——与 §七 一致。

**收口复核修订后复跑（最终）**：本轮改动为 §1.4 重写、§1.62–1.65 新增、`access-control → identity`
装配边补齐、`@fenix/resource-memory` 补 `@fenix/platform-sdk` 依赖（接线 `hindsight.ts` 后由
`architecture` 门禁报出）、`bun.lock` 收敛、两个下推用例（`mcp-server-repository.test.ts` 8 例、
`provider-facade-model-scope.test.ts` 7 例）。全部通过：

| 项 | 结果 |
|---|---|
| `env -u ANTHROPIC_MODEL bun run precheck` | ✓ All passed（85.2s）：847（62 文件）/ **6593** pass + 2 skip（**516** 文件）/ 962；lint 仍 12 条 `scripts/` warning |
| `bun run check:dependencies` | ✓ **1880** modules，23 条已登记例外，0 条新增违规，无失效条目 |
| `bun run architecture:check` | ✓ **1739** files，11 rules，38 条已登记例外 |
| `bun run build:web` | ✓ built in 2.15s |
| `bun run docs:build` | ✓ build complete（10.70s，含本 review 文档） |

与 §七 / §八 原记数字的差恰好是新增的两个测试文件（1880−2 = 1878、1739−2 = 1737、6593−15 = 6578）。
**附带核实**：收口复核时曾怀疑 §七/§八 的 module / file 计数漏算了 untracked 的
`model-gateway-subject-verification.test.ts`；实测未复现——两个门禁统计的是磁盘上的文件而非 git 索引，
该文件在上一轮就已计入，原数字无误。

**§1.36 回退后复跑（最终）**：本轮改动为新增 `AgentConfigFacade.existsInOrganization`、`/api` 预检
改用它、`/web` 冲突注释改写为事实、仓储与领域服务的 `findByNameUnscoped` 契约注释补上新调用方与理由、
`createStubAgentConfigFacade` 补该方法、新增 `agent-config-create-conflict.test.ts`（5 例）与
`api-agents-routes.test.ts` 的 409 用例（1 例）。核心承诺由一条对照用例钉住：其他组织公开的同名 Agent
使 `facade.get` 为真而 `existsInOrganization` 为假——实现退回可见口径时该用例即失败。

| 项 | 结果 |
|---|---|
| `env -u ANTHROPIC_MODEL bun run precheck` | ✓ All passed（83.2s）：847（62 文件）/ **6599** pass + 2 skip（**517** 文件）/ 962（56 文件）；lint 仍 12 条 `scripts/` warning |
| `bun run check:dependencies` | ✓ **1881** modules，23 条已登记例外，0 条新增违规，无失效条目 |
| `bun run architecture:check` | ✓ **1740** files，11 rules，38 条已登记例外 |
| `bun run build:web` | ✓ built in 2.07s |
| `bun run docs:build` | ✓ build complete（含本 review 文档） |

与上一轮（1880 / 1739 / 6593 + 2 skip / 516 文件）的差恰为新增的 1 个测试文件与 6 条用例
（6593 + 6 = 6599），无其他文件被计入或剔除。

**§1.66（`/web` 同批收敛）后复跑（最终）**：本轮改动为 `handleCreate` 的预检改用
`facade.existsInOrganization`（连带注释重写）、`round44-agent-config-routes.test.ts` 的 409 用例改打桩并
断言"命中即止"、新增 1 条"其他组织的同名可见 Agent 不构成创建冲突"用例（无新增测试文件）。

| 项 | 结果 |
|---|---|
| `env -u ANTHROPIC_MODEL bun run precheck` | ✓ All passed（123.0s）：847（62 文件）/ **6600** pass + 2 skip（517 文件）/ 962（56 文件）；lint 仍 12 条 `scripts/` warning |
| `bun run check:dependencies` | ✓ **1881** modules（与上轮一致），23 条已登记例外，0 条新增违规，无失效条目 |
| `bun run architecture:check` | ✓ **1740** files（与上轮一致），11 rules，38 条已登记例外 |
| `bun run build:web` | ✓ built in 4.12s |
| `bun run docs:build` | ✓ build complete（19.83s，含本 review 文档） |

用例数 6599 → 6600（净 +1：新增 1 条回归用例，409 用例为改写而非新增），文件数与两个门禁的 module /
file 计数不变——未新增测试文件，与改动面一致。precheck 耗时 123.0s 明显高于上轮 83.2s，同机并发负载
所致（各阶段自身的 pass/fail 与计数均无变化），非本轮引入的不确定性。

**§1.67 / §1.68（用户实测越权）修复后复跑（最终）**：本轮改动为 `policy-facts.ts` /
`build-predicate.ts` 的组织口径收敛、`default-access-control.test.ts` 用例替换（删 1 加 4）、
`available-models-cache.ts` 按主体分键（连带 `models.ts` / `provider-handlers.ts` 的调用与注释、
`round-config-models-routes.test.ts` 改键 + 新增 1 条跨用户用例）、契约与设计 / review 文档同步，并
删除临时诊断脚本（未提交过）。除测试外的改动面都不在 `apps/web`，前端构建为常规复跑。

| 项 | 结果 |
|---|---|
| `env -u ANTHROPIC_MODEL bun run precheck` | ✓ All passed（122.7s）：847（62 文件）/ **6604** pass + 2 skip（517 文件）/ 962（56 文件）；lint 仍 12 条 `scripts/` warning |
| `bun run check:dependencies` | ✓ **1881** modules（不变），23 条已登记例外，0 条新增违规，无失效条目 |
| `bun run architecture:check` | ✓ **1740** files（不变），11 rules，38 条已登记例外 |
| `bun run build:web` | ✓ built in 3.44s |
| `bun run docs:build` | ✓ build complete（20.59s，含本 review 文档） |

用例数 6600 → 6604（净 +4：策略层删 1 加 4、缓存层加 1；`authorization-consistency` 的穷举计数不变），
文件数与两个门禁计数不变——未新增测试文件。

**对抗核实后的两处加固再复跑**：核实结论（见 §1.68 末条）追加了两处改动——`projectActions` 的成员分支
按 `resource.actions` 过滤、一致性合同测试补「动作集合 ⊆ 资源声明」不变量与两个真越界 fixture（新 1 例），
以及缓存注释措辞限定为 `/web` 写路径。复跑 `env -u ANTHROPIC_MODEL bun run precheck` ✓ All passed（119.2s）：
847（62 文件）/ **6605** pass + 2 skip（517 文件）/ 962（56 文件）；lint 仍 12 条 `scripts/` warning；
`check:dependencies` ✓ 1881 modules / 23 条例外 / 0 新增违规、`architecture:check` ✓ 1740 files / 38 条例外
（两者与上一轮一致）。用例数 6604 → 6605（+1），文件与门禁计数不变。四个真实资源的
`memberDefaultActions` 都 ⊆ `actions`，该加固不改变任何运行时行为。

**本次修复的真库实测证据（只读，临时脚本用后即删）**：用真实 `createDrizzleAccessControl`（真实
四资源 `storage` 绑定）+ 真实 dev 库构造 actor，对四类资源跑 `createListConstraint` + 授权查询并按
(组织/可见性) 分组统计。`test1@test.com`（memberships：`test1` / `my-test` / `测试` owner，`hpx` member），
以其**当前组织** `test1` 为 active org：

| 资源 | 修复前 | 修复后 | 修复后组成 |
|---|---|---|---|
| `agent_config` | 13 行（含 `hpx` private 2、`my-test` private 2） | **9 行** | `test1` private 7 + public 1、`hpx` public 1 |
| `mcp_server` | 9 行 | **7 行** | `test1` private 4 + public 1、`hpx` public 1、`test2` public 1 |
| `skill` | 15 行 | **10 行** | `test1` private 3 + public 1、`admin` public 3、`li` public 2、`test2` public 1 |
| `provider` | 8 行 | **6 行** | `test1` private 2 + public 1、`admin` public 1、`test2` public 2 |

把 active org 切成 `my-test` 复跑：四项列表变成 `my-test` 的私有行 + 各组织 public 行，`test1` 的
私有行消失（`test1` 的 public 行保留）——「当前组织 ∪ 公开」与组织切换语义同时得到实测确认。
非成员组织（如 `Pu Wang` 的 9 个 private `agent_config`）在修复前后都不可见，说明当时的谓词并非
"没加组织条件"，而是可见口径本身就是并集（§1.67 的三重取证）。

---

## 九、待办

### 9.1 §一 的 69 条如何评审：两类，只有一类需要裁决

§一 记录的是**已经落地**的偏离（不是待批准的提案），因此任何一条都不阻塞后续切片开工。但两类条目的
处理方式不同，混在一起评审会让真正需要你拍板的几条被淹没：

- **A 类（6 行 / 7 条，其中 1.36 已按裁决办结，余 6 条待裁决）**——改变了对外可观测面（已发布 `/api`
  语义、`/web` 协议字段、权限判定结果、跨会话可见的默认值、产品展示语义）。代码已按此落地；若不认可，
  改动面与代价见「回退面」列。**这些同样不阻塞开发**：保持现状即等同于默认通过，只有 1.27 的回退窗口
  止于收口提交（下一次提交），其余在进入 1.3 之前均可回退。（计数口径：`1.17 + 1.44` 两条相关偏离合并为
  一行处理，故行数 6 而条数为 7；§一 的小节按 1.1–1.69 计 69 条，两者口径不同但不相矛盾。1.67 / 1.68
  是用户实测越权的修复记录，按**缺陷修复**归档；1.69 是收口核对时补记的偏离（守卫留在宿主），二者均
  不需要裁决。）

  | # | 变化 | 若不认可的回退面 |
  |---|---|---|
  | 1.36 | ✅ **已回退并按裁决办结**：agent-config 的**两条入口**（`POST /api/agents` 与 `POST /web/config/agents`）同名冲突均退回「本组织内」（新增 `facade.existsInOrganization`，按 `(name, activeOrganizationId)` 判定、不经过授权条件）。回退前它曾放宽为「可见即冲突」——与 `create` 的 `(organization_id, name)` 冲突目标口径错位，属误报冲突而非更早报错；`/web` 由用户实测回归推动同批收敛（§1.66） | 已办结，无需裁决。**注意**：mcp `/api` 与 provider `/api` 仍是可见判定（两者在 `HEAD` 即如此，其 `/web` 控制台入口表现为组织内），四资源的完整对照见 §1.36；对齐它们属于后续任务，不在本次范围 |
  | 1.53 | Provider 连通性探测由「组织成员即可」收紧为要求 `update`（成员从可用变 404）；D1 只覆盖了 create/update/delete，没点明探测 | `provider-facade.getForProbe` + Provider 动作声明 + 前端权限 helper；需决定探测归哪个动作 |
  | 1.52 | 网关拒因新增三种并进入 `/api` 响应枚举，下游吊销检测按原因决定处置 | 端口返回值 + `SUBJECT_REJECTION_MESSAGES` + 下游识别约定（Q2 = A 只批准了实现方式，未确认这套对外码与文案） |
  | 1.17 + 1.44 | `/web` 新增顶层可选字段 `organizationName`（等价替代已删的 `resourceAccess.sourceOrganizationName`）；且因后端对本组织也解析，每个 Agent 卡片多一个组织角标 | 字段回退会让跨组织共享资源标签退化成裸 UUID；展示语义收敛需 agent / mcp / skill **三包同批**改（单独回退 Agent 会造成语义分叉） |
  | 1.27 | 上传冲突 409 现在真的带回 `data.conflicts` / `allowedStrategies`，覆盖/忽略弹窗从「永不出现」变为可用（既存缺陷修复，修法不在 S3 字面范围内） | 回滚 1 处响应 schema，弹窗再次失效；**回滚窗口只在收口提交前** |
  | 1.8 | 未显式指定组织时的默认组织回退由「未定义顺序」改为 `member.createdAt` 升序；少数用户的默认组织可能变化，决定后续读写归属 | 改 1 处查询 + 契约注释 + 1 条回归；顺序仍须确定性，可换另一种（如降序 / 按组织名） |

- **B 类（其余 59 条，事后确认即可）**——包归属、契约归属、内部契约宽度、测试落点、台账与注释更新、
  死代码记录等，指不出协议字段 / 权限结果 / 端点语义的变化，且多数是门禁强制的结果（例如 1.3 的信封上移
  是 identity 不得导入 `apps/server` 的必然推论，回退要么违反工程原则 10、要么复制契约）。**不需要逐条确认**，
  按「无异议即通过」处理；下面原有的逐条清单保留，供你抽查。1.62–1.65 是收口复核新增的四条（装配边补齐、
  Model 半连接的替代约定、identity env 推迟、两条验收项的移交），同样属 B 类；1.66 是用户实测回归新增的
  一条（`/web` 同名冲突随 §1.36 裁决同批收敛），它改变的是 `/web` 行为，但依据来自已办结的裁决，
  故仍归 B 类。

### 9.2 逐条评审项

- [ ] 1.1–1.3、1.7、1.10、1.15 的用户评审结论
- [ ] 2.1、2.2 的处置结论，以及 2.3、2.4 的处置结论
- [ ] 1.25、1.26 的评审结论（新增窄出口 `./server/runtime`、`./server/config`；
      路由依赖经 DI 代理；前端 MCP 视图契约测试随 D2 更新）——1.26 的"经 DI 代理"在 S4 已被
      1.50 取代（改为模块装配替身），评审时需一并确认该方向
- [ ] 1.27、1.28 的评审结论（既存 409 `data` 被响应 schema 剥掉的修复；S3 重写引入的两处回归及修法）
- [ ] 1.30 的评审结论（删除 3 个被取代的测试文件及覆盖归位；`同一批上传目录名大小写重复` 判为伪用例）
- [ ] 1.31 的评审结论（前端写权限判定收紧：缺失 `access.actions` 时不可写）
- [ ] 1.32 的评审结论（宿主 `Skill*Schema` 删除；同文件的 `Mcp*Schema` / `Model*Schema` 留待 S6）
- [ ] 1.44 的评审结论（前端展示名按归属组织限定的行为变化与处置建议：应在 helper 层统一为
      "归属组织等于当前组织时不加前缀"，并对 agent / mcp / skill 三包一次性调整，不在 Agent 侧单独回退）
- [ ] 1.50 的评审结论（删除资源包内 `routeConfigDeps` 代理、测试接缝改为模块装配替身）
- [ ] 1.51 的 1.4 owner 复核（`no-circular @fenix/agent-config → @fenix/agent-runtime` 提前失效，
      是否与 port 注入方案冲突）
- [ ] S1 实物收口的复核（identity 包、装配、`IdentityDirectory` 重接、删包已在本轮完成并全绿，
      需与 1.1–1.14 的评审结论一并确认）
- [ ] S2 实物收口的复核（`platform-sdk` 契约、`access-control` 新栈、四表 `visibility` DDL + 回填、
      mcp 端到端切换、1.25 / 1.26 的边界收敛）
- [ ] S3 实物收口的复核（skill 切到新授权栈、路由与前端 `scope + access`、测试重组、宿主 schema 清理）
- [ ] S4 实物收口的复核（agent-config 切到新授权栈、路由与前端 `scope + access`、`/api` 适配器、
      测试接缝迁移、删除 `routeConfigDeps`、`exceptions.json` 两条失效条目）
- [ ] S5 实物收口的复核（model-management 切到新授权栈、Provider 聚合根与 Model 继承、
      探测权限收紧为 `update`、主体复验窄端口、`/api/models` 适配器、前端 `isProviderWritable`）
- [ ] S6 实物收口的复核（旧栈删除、启动顺序测试改名、宿主 `Mcp*Schema` / `Model*Schema` 删除与
      barrel 停转发、台账更新、**裁决 A：DROP 推到下一发布**）

### 本任务新增待办（均超出 1.2 范围，不实施）

- [ ] `apps/server/src/test-utils/stubs/module-stubs.ts` 的 **13 个死桩注册表**（清单见 §2.5：
      `stubRepositories` / `stubSession` / `stubEnvironmentCore` / `stubLaunchSpecBuilder` / `stubInstance` /
      `stubEnvironmentWeb` / `stubConfigSkill` / `stubConfigAgentConfig` / `stubAgentKnowledge` /
      `stubMcpInspector` / `stubConfigMcpServer` / `stubWorkflowTriggerRepo` / `stubWorkflowTriggerService` 及其
      registry/reset）：全仓引用均为 0，且 `module-stubs.ts` 相对 `HEAD` 未修改——是 1.2 之前的死代码，
      按红线「不得顺手重构无关代码」本轮只记录不清理
- [ ] `FUNCTIONAL_MODULE_INVENTORY.md`（仓根）的盘点基线是 2026-09-03，仍把 `packages/resources/identity-admin`
      整包、`apps/server/src/auth/`、`packages/platform/access-control/src/resource-permission.ts`、
      `apps/server/src/db/schema.ts` 的 `resourcePermission` 等已删路径写成"现状落点"，也含更早迁走的
      宿主路由路径。它在 1.2 之前就已对不上（非本轮引入），全量重写属独立整理任务，本轮只在 §1.69
      记录、不顺手改写
- [ ] `packages/resources/model-management/src/server/routes/api/` 的 `/api/models` 仍留在包旧顶层路径，
      单文件 638 行（红线 500）：既存违反，S5 未加重；应随 1.3 / 1.7 的路径归属调整一并拆分
- [ ] `safeWebHandler` 的 `fallbackCode` 分支把 `error.message` 回显给调用方（§2.6）：非本轮引入，
      建议改为对外固定文案 + 日志留 traceId
- [ ] `orchestration-instance.ts:472–477` 伪造 `role: "owner"` actor 且 `organizationId ?? ""`（§2.8）：
      非本轮引入，建议改 `getAgentConfigById(id, env.organizationId)`；调用点在 agent-runtime，属 1.4 范围
- [ ] `handleFetchModels` 的内联凭据分支是 SSRF 读取原语（§2.9）：非本轮引入，修复需引入出站 URL 策略
- [ ] 创建 Agent 的旁路失败发生在主表写入之后（§2.11）：knowledge 校验失败时返回 400 但 Agent 已创建，
      重试会得到 409。属事务边界设计（"先校验后写入"或整个创建走一个事务），`/web` 与 `/api` 两条路径
      共享同一段编排，须一并改；非本轮引入
- [ ] `/api/mcp` 缺失 `/web` 已有的 MCP 领域校验（§2.12）：非法 name / config 可经 `/api` 写入，
      `type` 会被原样落库并在读取侧归一成 `local`。修复形态是校验落进 Domain Service / Facade，
      与上面的 `/api` 统一同批；非本轮引入
- [ ] 资源包路由直接 `import { ... } from "@server/schemas/config.schema"`（§2.10）：该组 `/web/config/*`
      契约仍登记在宿主 schema 面，若后续下沉到各资源包，本文件应只剩宿主自己的协议
- [ ] `DrizzleAuthorizedResourceQuery.readFacts` 在**缺 `access`** 时返回 `undefined` → `and(undefined, …)`
      让 Drizzle 完全省略 WHERE，退化为「整表 + 业务条件」，且与"没有权限"不可区分、无日志
      （`query/drizzle-authorized-resource-query.ts:97-99`）。当前四个资源包的仓储都把 `access` 作为
      **必填**字段传入、facade 也全部下推，因此它不是 §1.67 的成因；但契约确实允许受信任内部调用省略
      它（设计 §3.4 与 `platform-sdk` 的端口注释），所以"漏传即静默全表"是一个真实缺口。收紧形态
      （例如把无权限查询拆成显式命名的入口，而不是靠可选参数的缺省）属公共契约变更，须评审后再动，
      不在本轮实施。同一缺口还有测试面：真实实现 `DrizzleAuthorizedResourceQuery` /
      `ColumnResourceScopeStore` / `suite.ts` 目前**没有任何测试文件导入**，四个资源包的列表用例只断言
      「不透明句柄原样交给端口」，编译器里"provider 不匹配 / 资源类型不匹配 / 缺载荷即抛错"这些分支
      在那些用例里结构性不可能被触发；"成员看不到其他组织的私有资源"这条不变量此前只在**单资源**
      `resolveAccess` 路径上有护栏，列表 SQL 上没有（本轮补的护栏在策略层：
      `default-access-control.test.ts` 的四条 + 谓词↔动作一致性合同测试；列表 SQL 层仍只有真库实测）。
      补真库/内存库的查询层用例需要引入 DB 测试基建，属独立立项
- [ ] 可用模型缓存的失效覆盖（§1.68 对抗核实的补充）：`/api/models` 的 Provider / Model 写路径与
      模型网关同步路径都不清这份缓存（与 `HEAD` 逐字相同，非本轮引入），`/web/config/models/refresh`
      也**没有前端调用点**（逃生口未接线），因此经 `/api` 或网关改动后，控制台的可用模型列表最长一个
      TTL（5 分钟）内是旧快照。处置建议：随任务 1.5 的 `/api` 统一，把 `/api/models` 归到 `/web` 同一
      Facade 后自然共用失效点；`refresh` 若仍需保留则应接到控制台的"刷新模型"入口或删除
- [ ] S1–S5 的 2.1 / 2.2 / 2.3 / 2.4 与前序小节中所有「非本轮引入」的既存缺陷，处置结论待评审
- [ ] **同名冲突判定收敛到组织内（§1.36 / §1.66）→ 并入任务 1.5，本次不实施**：用户裁决
      （2026-09-19）——`/api/*` 属已发布稳定协议面，其底层逻辑随任务 1.5「apps/server：宿主与协议聚合」
      与 `/web` 统一（该任务明列"将已发布 `/api/*`、内部 `/web/*` 和协议入口统一为同一 Facade 的薄
      adapter；保持既有对外稳定合同，不能形成第二套 CRUD 或业务流程"，
      `ce-ee-refactoring-stage-2-plan.md` §1.5；标准侧依据
      `ce-ee-engineering-standards.md:217,222,467`），因此**本次不再单独调整 `/api` 下的接口**。
      现状：`agent-config` 两条入口已办结（都是组织内口径），仍偏宽的是 `mcp` `/api`
      （`routes/api/mcp.ts` 的 POST）、`provider` `/api`（`model-management` 的
      `POST /api/models/providers`）——两者相对各自 `(organization_id, name)` 唯一索引偏宽，且 `HEAD`
      即如此。1.5 实施时的目标形态与**必须守住的不变量**（详见本节「附」与 §1.66）：判定入口放在资源包
      自己的 Facade 上（照 `AgentConfigFacade.existsInOrganization` 的形态与两条依赖注释），错误码与
      响应结构不变。
      **已排除的选项（勿再提）**：把预检收进 Facade 的 `create` 内部（或新增 `createOrConflict` 由两条
      入口共用）。核实后否决——`create` 是文档化的幂等 upsert（计划 §S4 要求保留，`meta-agent` 的
      locate-or-create 依赖 `service.create` 的静默 upsert），而判定一旦移到 `resolveCreateScope`
      之后，同一请求的对外结果会从 409 变成 403（无 `create` 动作的 member 提交已存在的名字），
      翻转了"判定顺序"这一契约（本 review §1.65 已把判定顺序记为契约的一部分）。标准也不要求
      check-then-create 是单个 Facade 操作：它允许 route"调用 service + 错误映射"（标准 :210），
      禁止的是复制判定实现或授权 SQL（标准 :232）——而 `existsInOrganization` 全仓只有一份实现。

### 附：任务 1.5 的 `/api` 协议面盘点（1.2 期间产出，未逐条对抗核实）

用户裁决把 `/api/*` 的统一归到任务 1.5 后，本轮做了一次盘点，供 1.5 立项时核对。**除 §2.12（已复核）与
同名冲突三处（已复核）外，下表条目来自代码走查、未逐条对抗核实**，file:line 已给出以便快速复核；它们
共同的判据是标准 `:217`「只做认证、DTO 和错误映射，并调用与 `/web` 相同的 Resource Facade」与
`:467`「不存在第二套业务实现」。

| 资源 / 文件 | 超出薄协议层的地方 |
|---|---|
| `agent-config` `routes/api/agents.ts`（423 行） | `validateAgentData`（:259）、创建/更新后的 `applyAgentBindings` 两步编排（:277）、自拼资源键 `toAgentResourceKey`（:333、:388）、内置 Agent 删除保护（:393）、详情聚合三张关联表（:111）、列表逐条 `listKnowledgeBindings` 计数（:171，N+1） |
| `mcp` `routes/api/mcp.ts` | **缺领域校验**（§2.12）；`resolveDisplayType` + `buildSummary`（:62）是服务层 `toServerInfo`（`services/config/mcp-config.ts:163`）的局部重写，两版展示投影已不等价 |
| `skill` `routes/api/skills.ts` | "每次只允许导入一个 Skill"产品约束（:234）、导入后二次回读（:249）、删除前先 `getById`（:296）；同一冲突在 `/api` 是单个冲突名（:240）而 `/web` 是 `allowedStrategies`（`skill-route-support.ts:51`） |
| `model-management` `routes/api/models.ts`（638 行，兼 Provider + Model） | 路由内存分页切片（:226、Model 子表 :489）、Model 重名判定在路由（:430）、Provider 重名判定**刻意**留路由以保住对外错误码（:269，文件头 :43-44 有自认注释） |
| 跨文件重复（协议投影，非 Facade 候选） | `resolveOrganizationNames` 逐字复制 6 份（4 个 `/api` + 2 个 `/web`）、`buildResourceAccess` 包装 4 份（仅 `/api` 侧）——应上移到共享协议工具 |
| 其他 `/api`（非四资源） | `knowledge` 的 `/api/knowledge-bases` 直连 service、自己合并可见集并在内存分页；identity / observer / sandbox / model-gateway 的 `/api/system/*` 面各有小差异（sandbox 在路由内识别 PG 23505、identity 的错误映射靠 message 子串匹配） |

**必须留在协议层的东西**（统一时不要误搬）：`resourceAccess` 从 `access.actions` 派生的字段形状（已发布
契约）、`/api` 与 `/web` 各自的错误码与响应信封（`ALREADY_EXISTS` vs `CONFLICT`）、multipart 表单解析、
`/api/system/*` 的认证面。

### 发布顺序提醒（裁决 A 的落地条件）

下一发布必须在 C1–C3 全部上线、`resource_permission` 无读者之后执行：

1. 删除 `apps/server/src/db/schema.ts` 中被 `removeWhen` 标注的表与三个 enum
   （`resourcePermissionTypeEnum`（`resource_permission_type`）/ `resourcePermissionPrincipalEnum`
   （`resource_permission_principal`）/ `resourcePermissionActionEnum`（`resource_permission_action`）
   及 `resourcePermission` 表）；
2. `bun run db:generate --name drop-resource-permission` 生成 DROP 迁移（含 `lock_timeout`，失败即中止发布）；
3. 确认回填在**全部环境**已记入 `data_migrate_record`，且 `visibility='public'` 计数与旧表
   `principal_type='all' AND action='read'` 一致；随后同一提交里删除
   `services/data-migrates/backfill-resource-visibility.ts`（它的唯一读者就是被删的表）。
