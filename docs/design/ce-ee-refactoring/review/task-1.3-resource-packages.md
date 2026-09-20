# 任务 1.3 实施记录：资源模块的完整交付物

范围：`docs/design/ce-ee-refactoring/ce-ee-refactoring-stage-2-plan.md` §1.3。
计划批准件：`.claude/plans/task-1.3-resource-packages.md`。

本文件记录**偏离、取舍、裁决理由与残留**；常规实现细节不入此文件。

---

## 一、范围裁决（2026-09-20，用户确认）

| 议题 | 裁决 | 影响 |
| --- | --- | --- |
| 包侧解耦范围 | 1.3 内一并切断 `@server/*` 与包内 web 的 `@/` 宿主别名 | 12 包的 `apps-boundary`（owner=1.5）与 16 包的 `web-package-not-to-app`（owner=1.6）条目由本任务同批削减；1.5/1.6 只保留宿主侧接线 |
| 分支重放 | 只重放 `packages/**`（`feat/ui-components-demo`），`apps/web` 侧归 §1.6 | 融合以本分支授权语义（`scope` + `access.actions`）为准；机械取分支侧会回退 1.2 成果 |
| 表定义 | 不迁；表定义、drizzle 聚合、DDL、迁移 manifest 归 §1.7 | `@server/db/schema` 作为**显式残留**保留，台账条目保留并改写理由（见 §四） |
| 未归属能力 | 授权 1.3 裁决并记录（见 §三） | 用户可单独推翻任一条 |

## 二、侦察实测（19 个只读 agent，2026-09-20，HEAD=aafebcef5）

交付物缺口（口径：`git ls-files` 实测，非估算）：

- `fenix.module.ts`：**0/13**；`README.md`：**1/13**（仅 sandbox；`agent-config` 有 3 行占位，其余 11 包无 README——首轮口径曾误记为「13/13 存在」，以 `git ls-files` 复测为准）；正确 `./web → web/index.ts` 形状：**1/13**（sandbox）。
- 包内 `@server/*` 导入 **352 处**（生产 259 + 测试 93）；包内 web 的宿主别名 `@/src`、`@/components` **588 处**（`packages/resources/*/web/*` 一级 glob 实测）。
- `apps/server/src/main.ts` 仍手写挂载 23 个包路由；`deploy/assembly/ce.json` 的 `resources`、`web` 均为空数组；`moduleConfigs` 只注册了 `identity`。
- 台账 62 条：owner 1.4=16 / 1.5=19 / 1.6=18 / 未排期=9，**1.3 名下 0 条**。
- 分支 `feat/ui-components-demo`（merge-base `d8e29658b`）：580 个改动、63 个双方修改（计划第 61 行的 518/62 是 `e8c73280a` 时点数字，已漂移）。

## 三、未归属能力归属裁决（授权范围内）

| 能力 | 归属 | 理由 |
| --- | --- | --- |
| Site / 站点 | agent-config | 现由其代管 `SiteFrame`/`SiteTabsBar` 与 agent-site 表，最小改动且与现有 owner 一致 |
| 文件域 | machine | `fs.ts`（622 行）留在 machine；分支把它放 agent-runtime 与 owner 冲突，按 owner 收敛 |
| 品牌 | WebShell（`apps/web`）+ identity（后端） | 持久化与解析在 identity，渲染在 Shell；本任务只在包内不新增品牌实现 |
| `/mcp/knowledge` 端点 | knowledge | 内容为知识库能力，端点前缀不改变 owner |
| peri-task 命名 | task | 语义为任务详情；`@server/schemas/peri-task-details` 随 task 切片迁入 |

## 四、残留与台账

1. **`@server/db/schema`（58 处 / 59 文件）**：表定义归 §1.7，本任务不迁。对应 `apps-boundary` 条目**保留**并改写 `rationale` 为「仅剩表定义导入，表定义迁出归 §1.7」，`owner` 由 1.5 调整为 1.7。不新建通配条目（加载器拒绝通配）。
2. **`manifest.web` 字段不在本任务声明**：其形状必须与 §1.6 WebShell 的消费方式同时设计；组件级静态值会让浏览器依赖沿 registry 进入 server 装配图，惰性形状需与 §1.6 共同定稿。1.3 只保证包侧 `./web` 导出面与浏览器安全守卫。
3. **`envDefinitions` 的宿主登记归 §1.7**：本任务只切断包内 `process.env` 直读（改经 `getModuleConfig` 或注入），不在 manifest 声明 env。

## 五、公共契约新增（计划 §2.6）

| 新增 | 规模 | 必要性 |
| --- | --- | --- |
| platform-sdk 共享错误分类法 | ~50 行 | 33 处 `@server/errors` 无对应物；宿主 `error-handler.ts` 按 `instanceof AppError` 映射 HTTP，各包自造错误类会让宿主无法映射 |
| `@fenix/platform-sdk/testing` | ~150 行 | 93 处 `@server/test-utils/*` 是宿主内部路径；13 包共用同一批桩（DB、模块配置、身份目录），自持会复制 13 份 |

两者均不改变既有对外协议、不引入新依赖。

## 六、实施中的偏离与发现

（随波次推进补充）

### 6.1 共享契约切片（错误分类法 / `@fenix/platform-sdk/testing` / `/api` 错误信封）

**落点与删除**

| 契约 | 落点 | 宿主侧删除 |
| --- | --- | --- |
| 错误分类法 | `packages/platform/platform-sdk/src/protocol/errors.ts`，经包根 `./protocol/errors` 导出 | `apps/server/src/errors.ts`（含仅在此定义、无任何导入方的 `ConfigWriteError`，随宿主副本一并消失） |
| `/api` 错误信封 | `packages/platform/platform-sdk/src/protocol/system-api.ts` 的 `ApiErrorResponseSchema` | `apps/server/src/schemas/api-common.schema.ts` 与 workflow 包的转发 shim（`packages/resources/workflow/src/server/schemas/api-common.schema.ts`，`export * from "@server/schemas/..."`，本任务前唯一消费方是它自己的 `api/workflows.ts`） |
| 测试桩 | `packages/platform/platform-sdk/testing`（新增 `exports["./testing"]`） | `apps/server/src/test-utils/helpers.ts`、`stubs/{auth-stub,db-stub,identity-stub,identity-directory-stub,create-stub-registry}.ts` |

**取舍**

1. 错误分类法并入既有 `src/protocol/`，不新建 `src/errors.ts` 平行模块：`protocol/` 已是「跨模块协议面」的既有落点（web 信封、system-api、resource-access-view），错误码与 HTTP 状态同属协议面。与同目录 `resource/errors.ts` 的 `ResourceAccessDeniedError` 刻意分开——后者是授权实现的拒绝信号，由 Facade 在边界映射成本层 `ForbiddenError`（理由写在两个文件头注释里）。
2. `apps/server/src/errors/orchestration-http.ts` **保留在宿主**：它是编排域错误码 → HTTP 的脱敏映射（含 `ENVIRONMENT_NOT_FOUND` 等宿主路由语义），只服务宿主错误处理器与 `/api/instances`，不是跨包分类法。宿主 `errors/` 目录因此保留单文件，`@server/errors/*` 子路径导入（agent-runtime 1 处）不受影响。
3. 宿主测试的复位聚合点落在宿主侧（新增 `apps/server/src/test-utils/reset-stubs.ts`，组合平台 `resetAllStubs` 与宿主 `stubs/*` 的 reset）：平台契约不得反向感知宿主模块替身，把宿主注册表塞进契约包会让契约依赖宿主实现。
4. `/testing` 的收纳边界写入子路径文件头注释：平台契约的替身在此（DB 句柄、模块配置、身份目录、认证入口）；各包自身模块的替身放该包 `/server/testing`；宿主自身模块的替身留在 `apps/server/src/test-utils/`。
5. `packages/chat-channel` 增补 `@fenix/platform-sdk` 依赖：其错误分类只依赖 `AppError` 的 `instanceof` 语义，除该包外无替代来源；`bun.lock` 同步 1 行。

**改指实测**：`@server/errors` 51 处 + 宿主相对 `../errors` 5 处全部改为 `@fenix/platform-sdk`；`ApiErrorResponseSchema` 8 处消费方（含 sandbox 3 处）同批改指。宿主 15 个测试文件与 `apps/server/src/test-utils/setup-mocks.ts` 同批改指到 `/testing` 与宿主 `stubs/*`。

**残留（不在本切片内完成，逐条有归属）**

1. **115 个包内测试文件仍导入已删除的宿主桩路径**（`@server/test-utils/helpers` 等，分布见 §6.2 映射表）：逐包改指需要同时决定「宿主模块桩归哪个包的 `/server/testing`」，属 W2 每包切片的边界切断范围；本切片只保证契约面可用。
2. **`scripts/__tests__/rmd-07-migration.test.ts` 的 `api-common.schema.ts` 条目已失效**：该守卫表钉死「宿主持有该文件」，而它已上移 platform-sdk（与 1.2 的 `common.schema.ts`、`errors/index.ts` 同类）。按 §4 共享文件协议由 W3 同批更新：删除 `["src/schemas/api-common.schema.ts", "apps/server/src/schemas/api-common.schema.ts"]` 一行、`toHaveLength(72)` 改 71，并补一条与 1.2 同风格的注释说明去向。

### 6.2 包内测试的共享桩改指映射（供 W2 各包使用）

平台契约替身（改指 `@fenix/platform-sdk/testing`）：`resetAllStubs`、`readJson`、`stubDb`、`stubAuthApi`、`stubAuthHandler`、`getAuthApiStub`、`stubIdentityDirectory`、`getIdentityDirectoryStub`、`stubModuleConfig`、`registerModuleConfigBaseline`、`getModuleConfigStub`、`initializeTestApplicationInfrastructure`、`createStubRegistry`。

宿主模块替身（现仍在 `apps/server/src/test-utils/stubs/*`，需按包归属迁入该包 `/server/testing` 后再改指，包内不得继续 import `@server/**`）：`stubEnvironmentRepo`（agent-runtime）、`stubCoreBootstrap`（agent-runtime）、`stubRegistry`/`stubRegistryHeartbeat`/`stubFileWsHandler`/`stubEnvironmentService`/`stubKnowledgeBaseService`（machine/knowledge 按 owner）、`stubConfigPg`（宿主 config-pg 服务）、`stubSystemApi`（identity 系统 API）、`stubPgStorageAdapter`/`stubCustomTools`（workflow）。

**注意（会静默改变测试语义）**：平台 `resetAllStubs()` 只复位平台契约自己的替身（DB 句柄、模块配置、身份目录、认证入口、应用基础设施）。宿主与包内模块桩的复位**不再是每包各调两次**，而是由持有者在被加载时经 `registerStubResetter()` 登记到平台契约的复位注册表：宿主 preload（`apps/server/src/test-utils/setup-mocks.ts`）登记宿主桩复位，包内 `/server/testing` 登记本包桩复位。方向不能反过来——平台契约不得反向 import 宿主或资源包的替身。宿主侧聚合点 `apps/server/src/test-utils/reset-stubs.ts` 已随该机制删除，112 个包内测试文件与原宿主测试统一调用平台 `resetAllStubs()`；漏登记会让用例出现「单独跑通过、全量跑失败」的跨用例泄漏。

### 6.3 门禁修复与模板加固（2026-09-20）

**T1 三处红门禁的根因与修复**

| 门禁 | 根因 | 修复 |
|------|------|------|
| `architecture:check` 报 stale 台账 | W0 契约切片删除 `apps/server/src/schemas/api-common.schema.ts` 后，`web-package-not-to-app / @fenix/resource-sandbox → @fenix/web-app` 条目（owner 1.6）不再命中 | 删除该条目（33 处 / 7 文件已随切片消失） |
| `check:dependencies` 解析失败 | 112 个包内测试文件仍导入已删除的 `@server/test-utils/helpers`，dependency-cruiser 判定为 couldNotResolve（门禁整体不可信） | 按 §6.2 映射改指平台 `/testing` 与宿主 `stubs/*`；0 个未识别符号 |
| `config-integration` 全红 | 包内模块配置读取没有测试接缝：平台 `getModuleConfig` 在未初始化基础设施时抛错，而包内用例本不该初始化宿主基础设施 | `setup-mocks.ts` 在保留真实实现的前提下加「未初始化 → 用桩」的窄接缝；沙盒配置形状由包自持（`@fenix/resource-sandbox/server/testing` 的 `createSandboxModuleConfig`），宿主不手抄字段清单 |

**T2a 装配依赖反向校验（`scripts/generate-module-registry.ts` 新增 `assertDependsOnComplete`）**

原生成器只做「声明了就必须成立」：`dependsOn` 里的条目必须指向已注册模块且是 `workspace:` 编译依赖。反方向无检查，于是 `sandbox` 生产代码静态导入 `@fenix/resource-machine/server` 却写 `dependsOn: []`，而装配校验（`platform-sdk` 的 `visit()`）只按 `dependsOn` 排拓扑序并报「依赖未启用模块」——profile 可以带着假依赖图启动，直到模块加载期才失败。新增校验判定范围（每条对应一种「不构成装配依赖」的情形）：

1. 只算 `resource` 类别模块：资源包之间的运行期耦合一旦装配就必须成套启用，这正是本任务要建立的资源包交付契约；`agent-runtime` / `identity` 在 profile 里是固定槽位（`requireFoundation` 总是启用），其跨类别边由 §2.3 矩阵与架构台账负责——这是本校验**已知的范围缺口**，owner 1.4。
2. 只算值导入与 `import()`，`import type` 编译期擦除不计入。
3. 只算 `src/**`（排除 `__tests__`）：web 贡献不进入服务端装配顺序，由 profile 的 `web` 列表表达。
4. 目标包尚未提供 manifest 时不做要求（此刻声明会被「引用未注册模块」拒绝），因此要求在目标注册的那一刻生效。
5. 已由台账登记为越界边的包对（`apps-boundary`、`special-dependency` 等，`no-circular` 除外——它给的是环上被挑中的一条边而非边级事实）不要求声明，也**禁止**写入 `dependsOn`：那类边必须消除，声明它会让 profile 同时启用两者时装配循环失败。

**W1 的强制点（已落地）**：`machine` 注册 manifest 时，`sandbox` 必须同时补 `dependsOn: ["machine"]`，否则生成器直接失败；`machine` 侧的 `machine → sandbox` 反向边已登记为 `special-dependency`（owner 1.4），因此不需要（也不允许）声明，方向与 §2.3 一致。

**该规则带来的落盘时序约束（并行适配必须知道）**：两条校验合起来要求「声明不得早于目标注册，也不得晚于目标注册」——目标没注册时声明会触发 `dependsOn 引用了未注册模块`，目标注册后不声明会触发反向校验。因此 13 份 manifest 的最终状态必须在**同一次落盘批次**里达成，任何并行拆批的中途态必然是红的（错误信息自解释：`引用了未注册模块 X` 与 `服务端代码导入了已注册模块 Y 但未声明` 成对出现）。这不影响提交纪律——批次末尾必须绿，中间态不提交。

本波次实测的依赖图（值导入 / 动态 `import()` 实测，非按 `package.json` 声明推断，扫描脚本语义与生成器一致）：

| 模块 | dependsOn | 依据 |
| --- | --- | --- |
| agent-config | knowledge, mcp, memory, skill | 本包 `src/**` 值导入四个资源模块的服务端入口 |
| machine | agent-config | `src/server/services/remote-file-service.ts` 读 Agent 配置、解析 AgentNode |
| mcp | knowledge | `src/**` 值导入知识库服务端入口 |
| model-management | agent-config | `src/**` 值导入 agent-config 服务端入口 |
| observer | agent-config, machine | `src/**` 值导入两者 |
| sandbox | machine | 沙盒实例创建与机器路由 |
| channel / knowledge / memory / prod-view / skill / task / workflow | 空 | 叶子模块 |

`knowledge` 的 `package.json` 里声明了 `@fenix/model-management` 依赖，但 `src/**` 无值导入（用途在 web 侧），故 `dependsOn` 为空——列此例说明「按代码实测」与「按依赖清单推断」会给出不同答案，后者会凭空引入一条装配边。

**T2 剩余项的落法（W1 波次，逐项对抗验证）**

| 项 | 范围 | 文件所有权（防并发写冲突） |
| --- | --- | --- |
| T2b 浏览器面守卫递归 | 从 `web/index.ts` 出发，`@fenix/<pkg>/<subpath>` 经 exports 解析到真实源文件并递归；白名单只留浏览器安全外部依赖；补负例断言 | `sandbox/web/__tests__/sandbox-browser-surface.test.ts` |
| T2c `./server` 出口收敛 | 移除 `getSandboxDatabase` / `SandboxDatabase`（先证无外部消费者） | `sandbox/src/server.ts` |
| T2e web 第三方依赖声明规则 | 单例框架库（react/react-dom/react-i18next/i18next/@tanstack/react-router）→ `peerDependencies`（范围与根 `package.json` 逐字一致）；可独立打包的普通库 → `dependencies`；仅测试用 → `devDependencies`。规则写入 `ce-ee-engineering-standards.md` | `sandbox/package.json`（dependencies/peerDependencies 字段） |
| T2f 测试加固 | 假绿测试重写为「包边界契约测试」（逐条对应 §1 静态条件，且必须先实测哪条今天不成立）；`guard-stubs.ts` 的不实覆盖声明改为实测结论 | `sandbox/src/__tests__/sandbox-source-migration.test.ts`、`guard-stubs.ts` |
| T2g admin-key 抽取 | 唯一实现落 `@fenix/web-runtime/web/lib/admin-key.ts`（存储键逐字不变），observer 6 处 + model-management 8 处改指，删除宿主副本与重复测试 | `packages/web-runtime/**`、observer/model-management 的 `web/**`、`apps/web/src/lib/admin-key.ts`、`apps/web/src/__tests__/system-sandbox.test.ts` |

同文件多写者的冲突已按「一个文件只有一个 owner」拆开：sandbox 的 `package.json` 归 T2c/e，`src/server.ts` 归 T2c，web 面归 T2b/g，`src/__tests__` 归 T2f。`@fenix/web-runtime` 依赖由编排者先写入 observer / model-management 的 `package.json`，避免与 W1 包 agent 的 `exports` 改动争用同一文件。

**W1 不新建 per-package `tsconfig.json`（偏离计划措辞，理由如下）**：计划 W1 行写「tsconfig 补齐」，但仓库没有任何 tsconfig 对 `packages/**` 做类型检查（宿主 `tsc` 步骤只覆盖 `apps/server`、`apps/web`、app 骨架），sandbox 作为黄金样本没有 tsconfig 且门禁全绿；现有 3 个包内 tsconfig（agent-config / memory / model-management）只声明 `@/` 与 `@server` 别名，属「宿主别名映射」，其生命周期归 §1.6（vite/tsconfig 别名收敛）。因此 W1 只保证 manifest / exports / README 三项，包内 tsconfig 的取舍与别名清理并入 W2 切片（`@/` 切断时必须同批删除失效映射），避免现在新增 12 份很快要删的文件。

### 6.4 W2 包切片配方（按代码实测的映射表，供各包 agent 直接执行）

「切断 `@server/*`」不是逐条改路径，而是**把宿主内部形状换成注入或平台契约**。按实测的导入符号归类，每类只对应一种改法：

| 现状（宿主符号 / 路径） | 实测规模 | W2 改法 | 依据 |
| --- | --- | --- | --- |
| `authGuardPlugin` 直接 `.use()` 注册 | 30 处生产代码 | 路由改工厂 `createXxxRoutes(deps)`，守卫由宿主注入；`deps` 类型写在包内 `src/routes/dependencies.ts`，只声明 `AnyElysia` | 沙盒样本；Elysia `macro`/`state` 是实例作用域的，父实例无法回填 |
| `type AuthContext` | 4 处生产代码 | 只取用到的字段（如 `{ organizationId, userId }`）或平台 `ActorContext`（`@fenix/platform-sdk` 的 `resource/authorization`） | 1.2 决策：「资源包与平台实现都只消费 `ActorContext`，不得自行解释 `AuthContext.role`」 |
| `authenticateRequest` / `RequestAuthResult` | 3 处生产代码（machine `file-events`、agent-config `agent-sites-proxy`） | 作为路由工厂的注入依赖传入，**不新增平台契约** | 与守卫同理：认证实现必须与宿主同一份实例 |
| `toActorContext` | 1 处（agent-config `system-entries`） | 宿主边界转换；包侧改为注入或接收已转换的 `ActorContext` | 同上 |
| `errorResponse` | 1 处（mcp `/mcp/knowledge`） | 改用平台 `/api` 错误信封（`protocol/system-api`） | 1.3 已下沉 `ApiErrorResponseSchema` |
| `setTestAuth` / `resetTestAuth` | 51 个测试文件各 2 个符号 | 改包内 `src/__tests__/guard-stubs.ts` 守卫替身（携带 `organizationId` / `userId`），与沙盒一致；**真实守卫**覆盖归 §1.5 宿主用例 | 包内测试不得 import 宿主；沙盒样本已如此落地 |
| `@server/config` | 16+14+7 处（knowledge/machine/skill） | `getModuleConfig("<module-id>")` + 包自持配置接口（沙盒 `getSandboxConfig` 样本） | 平台 `/server` 契约已有 |
| `@server/db` | 各包 1–7 处 | `getDatabase()`（`@fenix/platform-sdk/server`），读取必须发生在请求时 | 沙盒样本 |
| `@server/db/schema` | 各包 1–10 处 | **保留**（表定义归 §1.7），台账条目保留并改写 owner | §四残留 |
| `@server/test-utils/stubs/*` | 各包 1–17 处 | 平台 `/testing` 或归属包的 `/server/testing` | §6.2 映射表 |
| `@server/services/org-context` | 30 处**全在测试**（`setTestOrgContext` / `clearOrgCache`） | 直接消失：守卫替身已携带组织上下文 | 沙盒路由测试样本 |
| web 侧 `@/` 别名 | 588 处 | 拆成 `@fenix/ui-components`（UI）/ `@fenix/web-runtime/...`（浏览器公共能力）/ 包内相对路径；同时按 §6.3 T2e 规则声明第三方依赖 | 计划 §3 静态条件 2 |
| 分支 `feat/ui-components-demo` 的包侧改动 | 13 包共 170 文件 | 作为**参考**重放 web 文件；凡是与本分支授权语义（`scope` + `access.actions`）冲突处，以本分支为准 | 计划「只重放 packages/**，融合不机械取分支侧」 |

交付物（每包缺项按此补齐）：`web/index.ts` 浏览器出口、`web/i18n/{namespace,index,locales}`（键原寄居 observer 命名空间的按 owner 迁出，mover 只删除）、`src/module.ts` 工厂（进程级单例）、README 更新、包内测试全绿。

分层（按实测 `dependsOn` 拓扑修正，W2 执行口径以下表为准）：

| 层 | 包 | 依据 |
| --- | --- | --- |
| L1（9） | channel、knowledge、memory、prod-view、skill、task、workflow、mcp、machine | 无资源依赖，或其依赖只经对方**已存在**的服务端公开入口（mcp → knowledge） |
| L2（4） | agent-config、model-management、observer、sandbox（核验） | agent-config 需 machine 在 L1 新建的 `web/index.ts`（`registryApi`）；sandbox 的 `dependsOn: ["machine"]` 只影响装配顺序，包内已由 W0 完成 |

唯一会**改变形状**的跨包 web 依赖是 `agent-config → machine` 的 `registryApi`：分支写的是深层路径 `@fenix/resource-machine/web/api/registry`，本任务收敛为包根入口 `@fenix/resource-machine/web`（machine 的 `web/index.ts` 在 L1 建立）。其余跨包 web 引用（observer / model-management / agent-config → `@fenix/resource-sandbox/web`）今天已是包根入口，形状不变。

### 6.5 W2 输入：分支重放的经济学与共享 web 模块归属（编排者实测，2026-09-20）

**分支重放的规模与融合规则**（`git diff HEAD origin/feat/ui-components-demo -- packages/resources/*/web/**`，248 条）：172 个双方修改、43 个分支新增、33 个分支删除。172 个修改文件中 **108 个是纯 import 改写**（`@/…` → `@fenix/…`），可直接取分支版本；**64 个含语义变更**（1–5 行 16 个、6–20 行 21 个、21–60 行 13 个、>60 行 14 个），必须**以本分支为底**只取分支的 import 目标与新增文件——分支的 `skill/web/lib/skill-resource-access.ts` 用的是旧 `resourceAccess: ResourceAccess` 形状，机械取分支会回退 1.2 的 `scope` + `access.actions` 语义（计划 §7 风险 2 的实例）。

**共享 web 模块归属裁决**（分支侧与本仓库现状冲突处，逐条给结论）：

| 现状引用（实测处数） | 裁决 | 理由 |
| --- | --- | --- |
| `@/src/lib/admin-key`（8） | `@fenix/web-runtime/lib/admin-key` | T2-1 已落地；分支放新建的 `identity-admin` 包 |
| `@/src/contexts/OrgContext`（5，`useOrg`）、`@/src/lib/auth-client`（1，`useSession`） | `@fenix/identity/web` | 1.2 已发布身份浏览器入口，且**宿主已挂载同一 React context 实例**；复制到别处会产生第二个 context 导致 `useOrg` 永远拿到默认值。不采纳分支新建的 `packages/resources/identity-admin`——把身份前端能力放进 `resources` 类别与 §2.3 矩阵「resources 不得依赖具体 Identity」及 owner 归属冲突 |
| `@/src/types/config`（34，6 包共用，纯类型文件） | `@fenix/web-runtime/types/config` | 分支放 `agent-config/web/types/config`：会把 6 个包的公共类型挂到一个资源包上，形成跨资源 web 耦合（W4 的收敛对象） |
| `@/src/api/environments`（4，`envApi`） | `@fenix/agent-runtime/web/api/environments` | Environment 属 agent-runtime（§2.3 矩阵）；分支同判 |
| `@/src/lib/utils` 的 `cn`（10） | `@fenix/ui-components/lib/cn` | 分支同判；实测资源包只用到 `cn` |
| `@/components/ui/*`、`@/components/config/*`、`@/src/components/layout/*`、`@/src/pages/agent-panel/shared/*`、`@/src/lib/card-renderer` | `@fenix/ui-components/*` 对应子路径 | 分支同判；目标子路径已全部存在 |
| `@/src/api/request`（58）、`@/src/i18n` 的 `NS`（50）、`@/src/lib/config-events`（4） | `@fenix/web-runtime/{api/request,i18n/namespace,lib/config-events}` | 分支同判 |
| `@/src/{api,lib,types,pages}/<本包域>` | 包内相对路径 | 例如 `@/src/api/knowledge-bases` → knowledge 包内 `web/api/knowledge-bases` |

**不采纳的分支结构性差异**（除上表已列）：`packages/resources/identity-admin`（新包，29 个 web 文件 + 4 个服务端路由文件）；`model-management/src/routes/web/config/models.ts` 的扁平化（本仓库统一 §2.3 的 `src/server/routes/**`）；`sandbox/src/routes/**`、`machine/src/routes/**` 也在各自切片内移入 `src/server/routes/**`（共 9 个文件；其余 11 包已是该形状，计 72 个文件，故按多数方向统一）。沙盒样本的 `src/routes/**` 与 §2.3 的 tree 不一致，本节以 §2.3 为准——§2.2「契约以样本为准」指交付物形状（manifest/exports/工厂/守卫注入），目录路径按计划 §2.3 收敛。

分支新增文件的归属按「本包自身域」接纳（如 `agent-config/web/lib/{agent-node,agent-utils}`、`machine/web/api/registry`、`knowledge/web/pages/agent-panel/KnowledgeGraphPanel`、`workflow/web/lib/use-workflow-events`）。

### 6.6 W1 对抗验证的结论摘要（13 包 + 3 个 T2 链路，2026-09-20）

**零 blocker**：13 份 manifest 的 `id` / `kind` / `dependsOn` / `capabilities` 逐字符合裁定值，`exports["./module"]` 精确指向 `fenix.module.ts`，全部 export 目标文件存在，`dependencies`/`peerDependencies` 未被顺带改动。

**验证抓到的两类真实缺陷（W2 已纳入修复口径）**：

1. **README 断言过强**（9 个包命中，占多数）：含「唯一 / 只有 / 权威 / 全部」的表述实测不成立——mcp 的「表定义是本包唯一的宿主内部依赖」（实际另有 `@server/plugins/auth`）、machine 的「zip 上限两处同步」（zip 常量与文案全仓只有一份）、machine 的「四种交付物全部由 `src/server.ts` 的 default export 暴露」（`src/server.ts` 无 default export，是具名再导出）、agent-config 的「meta-agent.ts 用 toActorContext」（实为纯类型导入）、workflow/observer 的「package.json 只有 `.` 与 `./server`」（同批改动已加 `./module`）。W2 的 README 重写要求：每处强断言先跑命令确认。
2. **sandbox 的契约测试覆盖 6/8 条静态条件**（用 /tmp 副本做变异测试证明）：删除 `exports["./server"]` 键或把 README 换成单行占位，测试仍 10 pass——「键存在性」与「README 非占位」两组断言缺位；被删掉的 `./server` 工厂导出断言在包内没有等价替代（那三个工厂今天只被 `apps/server/src/main.ts` 消费，守卫落在宿主 tsc，owner 1.5）。W5 收口前补这两条断言，或在 review 明示缺口。

**真实性确认（非缺陷）**：knowledge 的 `process.env.GOTENBERG_URL`（`src/server/routes/web/knowledge-bases.ts:142`，全仓唯一一处、`apps/server/src/env.ts` 未声明）是**既有实现**，但违反 §1 静态条件 4 且未登记在 §1.7 的 env 收敛范围——W2 的 knowledge 切片按条件 4 处理（`getModuleConfig` 或注入），并把「该变量需要 env schema 声明」写进 README 已知项。

### 6.7 W1 收口（2026-09-20，编排者）

三处收口改动，均属 §4 共享文件协议里编排者独占的文件：

1. **`scripts/__tests__/rmd-08-migration.test.ts` 增列两项改判**（180 项保留目标，原 182）。W1 的 T2 链路按 §6.5 的共享模块归属删除了宿主侧两份文件，RMD-08 的「迁移后仍在 apps/web」表因此必须同步：`system-sandbox.test.ts` 的 owner 交给 `packages/resources/sandbox`（包内文件头已注明来源），`admin-key.ts` 上收 `packages/web-runtime/web/lib/`。两条都补了 relocated 断言（旧根路径、旧 app 壳路径、包内唯一落点三处同时校验），并写明理由——不写成「已退役」是因为它们仍在版本树里，只是换了 owner。计数从 `toHaveLength(182)` 改为 180，不留「数字对不上就删断言」的空间。
2. **清零 12 条 linter warning**（`apps/` 之外，全部来自任务 1.1 提交 4ab8d4712 的 `scripts/`）：11 条 `noUselessUndefined` 用 biome 安全修复（`return undefined;` → `return;`，语义等价），1 条 `check-architecture.ts` 未使用的 `sep` 导入手工删除。质量红线要求 warning 清零，且留着它们会让 W2/W3 的「新增 warning」不可判定，故在 W1 就归零。
3. **W1 门禁全绿**：`env -u ANTHROPIC_MODEL bun run precheck`（873 + 6713 + 960 项测试，0 fail、0 error、0 warning）、`bun run build:web`、`bun run docs:build`、`bun run generate:module-registry --check` 全部通过。
