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

### 6.8 W3 共享文件波次（2026-09-20，编排者；宿主侧与台账）

W3 只动 `apps/**`、`scripts/**` 与编排者独占的共享文件，`packages/**` 留给 W2.5 修复轮，避免同文件并发写。

1. **宿主 i18n 引导重写为「登记表」**（`apps/web/src/i18n/index.ts`）：12 个包命名空间的字典改经 `@fenix/<pkg>/web/i18n` 子路径登记，键的最终所在地 = 包的 owner（计划 §4）。用子路径而不是包根入口，因为本模块在应用启动时求值，从根入口导入会把整个控制台页面图（页面、Radix、api client）拉进首屏 bundle。命名空间字面量取自中心表与各包常量，宿主不再复制字面量——两份字面量分歧的症状是文案整片回退成 key 回显，且构建期不可见。`ns` 列表改为 `Object.keys(resources.en)`，消除「注册了字典但漏进 `ns`」的静默回退。`SANDBOX` 取自 `@fenix/resources-sandbox` 的常量（中心表缺该键，见 §6.9 移交项）。
2. **落地验证（宿主测试 596 pass / 9 fail / 9 error → 960 pass / 0 fail）**：修复前 `apps/web/src/__tests__/` 有 9 个用例因字典旧深链（`../i18n/locales/en/agents.json` 等）整文件 0 断言，9 个 error 来自 `@lobehub/icons → antd-style` 在无 DOM 进程加载期裸调 `matchMedia`。前者由本节的改指消除，后者由 `apps/server/src/test-utils/setup-globals.ts` 的最小 `matchMedia` 垫片消除（结构对齐 `MediaQueryList` 但不引用该 DOM 类型：server 侧 tsconfig 未加载 DOM lib，写出类型名即 `TS2304`）。垫片不是 DOM，需要真实 DOM 的用例仍各自建 happy-dom Window。
3. **宿主死副本与 owner 归属收敛**（共 11 份，全部零消费方或消费方随批改指）：
   - **删除**：`apps/server/src/schemas/{api-model,config}.schema.ts`（owner 在 model-management 包）、`apps/server/src/test-utils/observer-fixtures.ts`（owner 在 observer 包）、`apps/web/components/MetaAgentPanel.tsx`（owner 在 workflow 包）、`apps/web/src/hooks/useMetaAgent.ts`（owner 在 agent-config 包）、`apps/web/src/lib/use-workflow-events.ts`（owner 在 workflow 包）。
   - **改指后删除**：`apps/web/src/types/config.ts`（13 个消费方 → `@fenix/web-runtime/types/config`，含宿主唯一非测试消费方 `PermissionTab.tsx`）；`apps/web/src/i18n/locales/{en,zh}/{agents,models}.json`（最后一个消费方 `agent-resource-picker-interaction.test.tsx` 改读 `@fenix/agent-config/web/i18n` 的 `agentResources.en`，两个断言键的取值与宿主字典逐字相同）。
   - **保留**：`apps/server/src/schemas/peri-task-details.ts` 有活宿主消费者（`routes/web/peri-task-details.ts`、`schemas/index.ts` barrel），不在删除清单；其迁移归 §三 已裁决的 task 包。
4. **台账同步**（不写会立刻变红——它们断言 target 必须存在）：`scripts/__tests__/rmd-07-migration.test.ts` 从 70 项收敛到 68 项，新增 `RMD_07_RELOCATED`（2 条 Provider / Model schema）；`rmd-08-migration.test.ts` 从 180 项收敛到 172 项，新增 `RMD_08_RELOCATED`（8 条，三元组断言旧根路径、应用壳路径、包内 owner）。三条 relocated 断言都保持「两处不得复活 + 包内唯一落点」的形状，计数写死，不留「数字对不上就删断言」的空间。`apps/server/src/schemas/index.ts` 关于 `./config.schema` 的陈旧注释同步改写。
5. **`deploy/assembly/ce.json` 裁决：本任务不登记 `resources`**。§1.3 的交付物是包侧 manifest / README / 路由贡献 / web 出口 / 测试；「`/web/*`、`/api/*` 路由改为模块 route contribution 由宿主挂载」明确归 §1.5。CE 组合当前经 `apps/server/src/main.ts` 的显式挂载运行，`moduleConfigs` 只注册 identity。此刻往 `resources` 填包会把「实例化语义」提前引入 1.3，并与 `apps/server/src/__tests__/module-assembly.test.ts` 的 `EXPECTED_SERVER_MODULES`（identity / access-control / agent-runtime 三项）冲突。生成物 `apps/generated/module-registry.ts` 已含全部 17 个 manifest，无需重跑 `generate:module-registry`。
6. **本节的门禁证据**：`bunx tsc --noEmit`（根，覆盖 apps/server 与 packages）exit 0、`bunx tsc -p apps/web/tsconfig.json --noEmit` exit 0、`bun test apps/web/src/__tests__/` 960 pass / 0 fail、`bun test scripts/__tests__/rmd-0{7,8}-migration.test.ts` 7 pass / 0 fail。`bun test apps/server/src/__tests__/` 仍有 38 项失败，全部是 W2 逐包迁移留下的宿主侧残差（33 项 `应用基础设施尚未初始化`：包内服务改经 `getModuleConfig` 读取后宿主测试桩未注册基础设施；`source-route-imports.test.ts` 指向 W2 前的 `packages/resources/agent-config/src/routes/**` 旧路径），与本节改动无交集（根 tsc 全绿已排除悬空导入），随 W2.5 修复轮收口后在 W5 复测。

### 6.9 交接给后续任务（W3 只读实测，未动手）

1. **10 对宿主 ↔ 包**逐字节相同**的实现**（按 sha256 全仓比对，`apps/**` × `packages/**`）：`components/ui/{chart.tsx,use-roving-list-navigation.ts}`、`components/config/index.ts`、`src/vite-env.d.ts`（以上 `@fenix/ui-components`）、`src/hooks/usePageVisible.ts`、`src/lib/artifacts-preview-events.ts`、`src/lib/use-context-queue.ts`、`src/api/request.ts`（以上 `@fenix/web-runtime`）、`src/lib/{agent-node,agent-resource-access}.ts`（`@fenix/agent-config`）。处置归 §1.6 的 apps/web 收敛：宿主消费方（页面、hook、API client）随页面下沉包内，宿主副本届时自然消失。**1.3 范围内不逐份改指**——`api/request.ts` 有 15 个宿主消费方且被 `vite.config.ts` 别名与 `architecture-check.test.ts` 引用，属 §1.6 的收敛对象；`ui-components` 的接入是已登记的延期缺陷。
2. **`@fenix/agent-config` 缺 `./web/lib/*` 出口**：`web/lib/{agent-node,agent-resource-access,agent-utils}.ts` 已在包内，但 `exports` 只有 `.`/`./module`/`./server`/`./server/testing`/`./server/runtime`/`./web`/`./web/i18n` 等，宿主消费方无法在不经包根入口（会拉整图）的前提下改指。补出口是包侧改动，随 W2.5 后的批复一并做，或由 §1.6 在页面下沉时判定不再需要。
3. **包侧陈旧注释已订正**（于 §6.10.3 处理）：observer `README.md` 与 `src/__tests__/observer-package-contract.test.ts` 原写「宿主 `observer-fixtures.ts` 暂不在本清单，由编排者执行」——该宿主文件已删除，路径**已纳入 `HOST_PATHS_REMOVED` 清单**（此前只记在 README，清单才是这条不变量真正的守卫）；workflow `src/__tests__/workflow-source-migration.test.ts` 的 `HOST_LEFTOVER_PATH` 注释与 `README.md` 原写「待宿主 owner 删除」——宿主三份副本已删，注释改为完成态并说明路径常量为何保留；agent-config `web/index.ts` 原把宿主 `hooks/useMetaAgent.ts` 列为 `sidebarConfigApi` 消费方——已删，注释改为「发布方在本包、宿主副本已删」；mcp `web/__tests__/config-mcp-types.test.ts` 的出口曾写成 `@fenix/web-runtime/web/types/config`——订正为权威 specifier `@fenix/web-runtime/types/config`。
4. **`@fenix/identity` 的 i18n 出口债**：apikey / orgs 两份字典仍以深层相对路径（`packages/platform/identity/web/i18n/{en,zh}/*.json`）读取，该包无 `/web/i18n` 出口；宿主 i18n 引导里已就地注释说明，随 identity 前端收敛处理。
5. **`GOTENBERG_URL` 需进 env schema**（§6.6 的真实性确认项）：`apps/server/src/env.ts` 未声明，属 §1.7 的 env 收敛范围，1.3 只保证包内不再直读 `process.env`。
6. **warnings 与中心表**：`@fenix/web-runtime/i18n/namespace` 的 `NS` 缺 `SANDBOX`（宿主暂用包常量，`admin.tsx` 的 `ns` 因此声明为 `string` 而不是中心表的 `Namespace` 联合类型）；`UI_COMPONENTS` 只登记名称、字典归 `@fenix/ui-components`（未接入，已登记延期缺陷）。两者都属「中心表 vs 包」的一致性收口，建议与 §1.6 的 ui-components 接入同批。

### 6.10 W2.5 修复轮收尾（2026-09-20，编排者）

#### 6.10.1 `bun test packages/` 的 3 项残留失败：根因在 bun 1.3.x，不在被测代码

**现象**：全量 `bun test packages/` 恒定 3 项失败，全部是 machine 文件服务里驱动**真实子进程**的用例（`fs-download-zip.test.ts` 与 `agent-file-service.test.ts` 的 `downloadZip` 生命周期三例）；这些文件单独运行必过。

**先排除回归**：用 HEAD（`aafebcef5`）建独立 worktree 跑全量 = **4767 pass / 244 fail**，这 3 项与 `agent-file-service.test.ts` 的全部用例都在失败列表里。本轮工作把 244 收敛到 3，残留不是本轮引入。

**根因**：bun 1.3.13 的运行时缺陷——进程内求值完一个较大的模块图后，`spawn` 出的子进程**写不进任何 fd**：

| 入口 | 干净进程 | 触发条件 |
|---|---|---|
| `Bun.spawn` | `code=0`，`"hi\n"` | `code=1`，空输出 |
| `node:child_process.spawn` | `"hi\n"` | 空输出 |
| `spawnSync` | `status=0` | `status=1`，空输出 |
| `execSync` | 正常 | 抛错 |
| `zip` 子进程 | `code=0`，1090 字节 | `code=10`（Info-ZIP stdout EPIPE） |
| `echo` → **普通文件 fd** | 正常 | `code=1`，文件为空 |

最后一行是判据：stdout 指向普通文件同样失效，因此不是 pipe 的问题，而是子进程输出 fd 整体无效；`Bun.spawn` 与 node 兼容层同时坏，排除「某个包装层」的解释。**触发条件**：求值 `@fenix/model-management/web`（值导入图 111 个文件）或 `agent-editor-model`（124 个）即触发，4 个 ui 组件与 8 个小 api 模块不触发——这解释了「单文件必过、全量必挂」。

**已排除**：单一元凶模块（二分不收敛）、ESM 循环、`process.env.PATH` 串台、并发（`--max-concurrency 1` 仍挂）、fd 上限（`ulimit -n` 已是 1048576；`/dev/fd` 2694 → 11185 是 fd 号空间膨胀，不是 EMFILE）。

**处置**：CI 固定版本 `1.3.14 → 1.4.2`（`.github/workflows/ci.yml` 两处）。bun 1.4.2 上同一复现组合 0 失败、全量 `bun test packages/` = **7127 pass / 2 skip / 0 fail**（7133 tests / 572 files）。本地开发机需同步升级（本机为 Homebrew 安装，`brew trust oven-sh/bun && brew upgrade bun`）。

**复核条件**（不是移除条件）：若 CI 因故退回 1.3.x，这 3 项会再次变红——届时**不要**改产品代码、**不要**删用例，先确认 bun 版本。`downloadZip` 的实现与 HEAD 字节级一致，用例断言的是真实产品行为（zip 流式输出、客户端断开时 kill 子进程）。

**不确定性（明确标注）**：机制是从运行时行为反推的，未定位到 bun 源码内部路径，因此「bun 缺陷」是强推断而非逐行证实。

**方法论教训（记录以免复发）**：本轮排查一度以「只看汇总行 `N fail`」判定，把探针文件 import 解析失败（`Cannot find module '@fenix/ui-components/ui/separator'`）误读成 zip 用例失败，据此产出「图规模阈值 = 12」「4 个 ui 组件触发」等数轮错误结论；另有一次把非 `*.test.ts` 文件当测试跑（bun 未加载它），整批阈值实验无效。改用 `(fail) <用例名>` 判定并显式排除解析错误后才收敛。**判定必须锚在用例名上，不能锚在计数上。**

#### 6.10.2 knowledge ↔ model-management 页面级环闭环

**形状**：knowledge 的 `AgentKnowledgeBasesPage` 从 `@fenix/model-management/web` 取 `EmbeddingModelManager`，而该组件又从 `@fenix/resource-knowledge/web` 取 `embeddingModelApi` 与 embedding 类型——两个包的值导入图成环。HEAD 时期这条回边经宿主别名 `@/src/api/knowledge-models` 表达（`apps/web/vite.config.ts` 把它映射进 knowledge 包），包图上的环一直存在。

**收敛**（§6.9 前已登记在 `model-management/README.md` 的候选方向一）：`EmbeddingModelManager` 连同它的 api 用法整体移入 `@fenix/resource-knowledge/web`（落点 `web/src/pages/agent-panel/components/EmbeddingModelManager.tsx`），`@fenix/resource-knowledge` 从 model-management 的 `dependencies` 移除，knowledge 侧不再引用 model-management。**归属依据**：组件管理的是 RAGFlow 的 embedding 模型（数据面就是 knowledge 的路由 `POST /web/knowledgeBases/models`），唯一消费方是 knowledge 的页面，且零 model-management 内部依赖（只用 ui-components / web-runtime / ahooks / lucide / sonner）——按「资源类型 + 表 + 归属列」的单归属口径归 knowledge。

**曾走错一步（记录以免重犯）**：先是给 knowledge 开了一个深层子路径 `./web/models`（`web/models.ts`），撞上 `packages/resources/task/web/__tests__/task-browser-surface.test.ts:259` 的「兄弟资源包只经包根 web 出口进入（不写深层子路径）」守卫。该守卫是对的，子路径与 `models.ts` 已删除。另需注明：环即便被切断，上述 zip 用例仍然失败，因此这次收敛是**独立于** bun 缺陷的正确修复，不是为了修 zip 才做的。

**守卫与台账同步**：knowledge 守卫自检列表 +1（`src/pages/agent-panel/components/EmbeddingModelManager.tsx`，`size` 15 → 16）、跨包入口列表去掉 model-management；model-management 守卫自检列表 −1、`^export` 17 → 16、跨包入口列表去掉 knowledge；`rmd-04-migration.test.ts` 的该条用三元组第三项记录新落点（原判定保留供追溯）；两包 README 与相关注释同步改写。

**遗留**：knowledge 的 `web/src/**` 残留层级仍在（`AlgorithmDetailDialog`、`AlgorithmsPage` 仍从 `web/index.ts` 转出），收敛前提是宿主路由懒加载路径一起改，归 §1.6。

#### 6.10.3 门禁收口（W3 遗留）

1. **`apps/web/package.json` 补 10 条 workspace 依赖声明**：W3 重写宿主 i18n 引导后，`apps/web/src/i18n/index.ts` 与 `src/lib/*.ts` 直接导入 `@fenix/resource-{channel,knowledge,mcp,memory,observer,prod-view,skill,task,workflow}/web/i18n` 与 `@fenix/web-runtime/*`，但宿主 `package.json` 未声明——`architecture:check` 报 24 条 `undeclared-workspace-dependency`。补声明后 `bun install` 更新 `bun.lock`。W3 收口时未跑完整 precheck，这条因此漏到本轮。
2. **删除失效例外**：`scripts/architecture/exceptions.json` 的 `web-package-not-to-app @fenix/resource-machine @fenix/web-app`（`removeWhen: machine 的 web contribution 不再引用宿主内部实现`）已不再违规，按检查器要求删除（已登记例外 31 → 30）。
3. **falsified 诊断的更正**：`packages/platform/platform-sdk/src/testing/workspace-root-lock.ts` 的头部注释原把 `downloadZip` 空流归因为「workspace 根串台」（`zip` 退出码 12），已改为 §6.10.1 的实测结论并保留锁本身的理由——错误的根因记录比没有记录更有害。同理更正了 `provider-model-resource-access-flow.test.ts` 与 `agent-editor-model.test.ts` 的「阻断项」段（宿主 i18n 改指各包 `@fenix/*/web/i18n` 后，两条链已在无 DOM 的 `bun test` 进程里正常求值）。
4. **本节门禁证据**：`env -u ANTHROPIC_MODEL bun run precheck` 全绿（`875 + 7127 + 960` 项测试，0 fail、0 error、0 warning；含 `format` / `import-sort` / `module-registry` / `architecture` / 三路 `tsc` / `dependency-boundaries` / `lint`）、`bun run build:web`、`bun run docs:build`、`bun run generate:module-registry --check` 全部通过（bun 1.4.2）。

### 6.11 复核轮：逐包对抗审计与缺口收口（2026-09-20，编排者）

#### 6.11.1 为什么门禁全绿之后还要再来一轮

§6.10.3 的门禁是全绿的，但 `precheck` / `build:web` 能证明的只有「没有编译错误、没有测试回归、没有 lint 违规」。§1.3 的验收里有相当一部分是**形状要求**——唯一 owner 的交付物、app 与 package 之间不得留下重复实现、跨包只经对方包根入口、浏览器入口只从 `./web` 导出且覆盖七种状态——这些没有任何一门现有检查会捕获：route 里的越权写、README 里写着已经不存在的待办、页面缺 error 分支、只弹 toast 就落回空态，门禁全都不会响。「测试全绿」与「交付物达标」不是同一件事。

因此做一轮只读审计：13 个包各一个 agent，对照 §1.3 原文与 `.claude/plans/task-1.3-resource-packages.md` 的 8 条静态条件 + 动态验收**逐条 grep 实测**（不接受「看起来应该有」），每个发现再派一个独立的对抗式验证 agent 复跑取证、默认怀疑、允许推翻。

#### 6.11.2 审计结论

44 个发现：blocker 0 / major 11 / minor 33。验证裁定：**CONFIRMED 38 / PARTIAL 6 / REFUTED 0**。

| 包 | 发现数（major） | 代表性一条 |
|---|---|---|
| agent-config | 4（1） | §1.3(3) 后半段「生成已授权 LaunchSpec 再调 Runtime port」包内完全未实现 |
| channel | 6（2） | PATCH `/web/channels/bindings/:id` 只校验原绑定归属，可越权改指他组织环境 |
| knowledge | 3（—） | 死副本 `agent-editor-knowledge.css`；web 无「无权限」态 |
| machine | 1（1） | 宿主 `api-workspace.schema.ts` 重复实现且零消费方；README 补丁清单第 4 条已过期 |
| mcp | 2（1） | 5 个源文件导入 `drizzle-orm` 但 `package.json` 未声明，靠根 hoisting 偶然解析 |
| memory | 4（1） | 7 个 `:id` 代理端点路径参数未编码，可穿透 `/v1/default/banks/{bank}/` 前缀 |
| model-management | 4（1） | `/api/models`(652 行)、`/api/system/model-gateway`(478 行) 两个工厂零测试 |
| observer | 4（—） | 日志下载绕过统一请求层、失败无反馈、401 不清 admin key；人员树 service/repository 零行为测试 |
| prod-view | 4（1） | `AgentProdViewsPage` 加载失败落进空态显示「No ProdViews」，无重试 |
| sandbox | 2（—） | route → route 依赖边（`sandbox-server` ← `sandbox-cluster` 的错误映射器） |
| skill | 3（—） | `gray-matter` / `js-yaml` 未声明；`skill-facade.ts` 518 行超限 |
| task | 4（2） | 列表失败退化为「暂无任务」；web 侧零 `UNAUTHORIZED` 消费点 |
| workflow | 3（1） | `WorkflowPage.tsx:64` 用 `window.history.pushState` 导航（前端规范 P0 禁令） |

#### 6.11.3 验证改写了什么：6 项 PARTIAL 逐条

**0 REFUTED** 说明审计 agent 没有编造发现。但 6 个 PARTIAL 说明「发现不假」与「发现说得对」是两件事——被改正的恰恰是取证方式，这一类错误如果直接落成待办清单，会让后续 owner 按错误的形状返工：

1. **agent-config `AgentSidebarConfig` 双份实现「未登记」→ 部分成立**。宿主那份已在 `docs/design/2026-09-18-packages-web-ui-components-migration.md:122` 的 C2 归属表逐行登记（归属 §1.6），并非「无任何登记处」。真正不实的是另一头：包根 `web/index.ts` 导出的 `AgentSidebarConfig` 符号**零消费方**，而宿主实际消费的是同名的本地副本里的 `AgentSidebarQuickNav`；`web/index.ts:14` 的注释还把 `ensureMetaAgent` 记在这个文件上（实际取它的是 `AgentSidebarTree.tsx:1`）。
2. **channel「repository 边界零测试」→ 前提不成立**。`findByChannelAndAgent` 这个死方法（参数 `channelId` 绑在主键列上，自 2026-05-16 起无调用方，属迁移前既有代码被逐字搬迁）成立；但「真实 SQL 从未执行」不是 channel 的缺口——全仓没有任何资源包对 repository 跑真 Postgres SQL（`stubDb()` 是平台提供的 seam），13 个包里只有 7 个有 repo 测试，且 §1.3 的验收口径不含仓储层用例。按此结论只删死方法，不补仓储用例。
3. **knowledge「6 个组件 76 处硬编码中文」→ 计数与文件数都不对**。注释感知重扫实测 **75 处 / 4 个文件**；被点名的 `ResourcePreviewContent.tsx` 与 `KnowledgeGraphPanel.tsx` 各 **0 处**（全部「中文」都在注释里）。样本行号内容逐条核对准确，用户可见性也成立（宿主 vite alias 直指包内页面、`fallbackLng: "en"`），但「knowledge 独有」的隐含前提不成立：同批 `model-management` 的 `AlgorithmsPage` 有 163 处、`agent-config` 的 `SiteFrame.tsx` 35 处——这是迁移带入的**存量口径问题**，不是某个包违约。
4. **sandbox 窄投影「自述理由已不成立」→ 只对一半**。文件头写的两条理由里，「observer 的 `./web` 出口尚未登记」确已过期（现已登记）；但第二条「observer → sandbox 已是既有依赖方向，反向 import 会形成包级环」经实测**仍然成立**（observer 有 7 个生产文件导入 `@fenix/resource-sandbox/web`）。且文件头本身已写移除条件。结论：保留文件、只修正过期的第一条理由 + 在 README 登记。
5. **task「列表/详情失败都不渲染 error」→ 「详情」不实**。`TaskLogDialog.tsx:114-115` 已渲染 error 分支，只有列表侧成立。
6. **workflow「整行点击键盘不可达」→ 两处里只有一处成立，且漏了第三处**。`WorkflowVersions.tsx:179-182` 成立；`WorkflowRuns.tsx:266-278` **不成立**——同行有恒渲染的「查看详情」按钮，`onClick` 调同一个 `onSelectRun` 且多传了 `workflow_id`；反倒鼠标点整行因宿主 `workflow.tsx:48-58` 的 `if (workflowId)` 守卫而**是空操作**，唯一生效的恰是那个键盘可达的按钮。另漏了同一模式的第三处 `components/VersionPanel.tsx:219-225`（同属 live 路由），属低估。

#### 6.11.4 通用原则：阶段 2 的重构要求覆盖阶段 1 的「保持原样」迁移合同（2026-09-20，用户裁决）

这一轮最需要固化的判断，是当「§1.3 的验收原文（例如 §1.3(6) 要求浏览器入口覆盖 loading / empty / error / retry / 无权限 / 成功反馈 / a11y 七态）」与「阶段 1 物理迁移时「照搬既有实现、不改行为」的合同」冲突时以谁为准。用户裁决：**以阶段 2 为准**。

> 我们现在是阶段 2 了，阶段 1 的要求是照搬已经完成，现在阶段 2 的要求是重构，所以这种情况是阶段 2 覆盖阶段 1 的。

因此：迁移进来的页面**缺 error / retry / 无权限 / a11y** 不再能以「阶段 1 就是这样的、照搬不改行为」作为豁免理由，一律按 §1.3(6) 补齐；反过来，阶段 1 已完成的照搬部分不因阶段 2 的要求而重新打开。这条同样解释了为什么 §6.11.3 的第 3、6 项（存量硬编码文案、整行点击）不以「迁入前就有」为由关闭。

**与「超出任务的改进只记录」的边界**：本节区分的是两类东西——**验收原文点名要求的形状缺失**（补齐，本任务做）与**验收未要求的质量改进**（只登记，本任务不做）。前者见 §6.11.7，后者见 §6.11.8。

#### 6.11.5 四项范围裁决（2026-09-20，用户确认）

| 争点 | 裁决 |
|---|---|
| 前端七态缺失 | **全部补齐**（按 §1.3 原文）——依据 §6.11.4：阶段 2 覆盖阶段 1 |
| 存量硬编码文案 | **登记归后续，1.3 不动**。明确是「暂时不想动」的范围选择，不是「合同不要求」的豁免——所以登记项必须保留「英文用户会看到中文」这一事实，不能写成「无问题」 |
| §1.3(3) 后半段 / AgentConfig Facade 的 port 化 | **归 §1.4，1.3 只登记**（台账 `agent-runtime-not-to-resources` 的 owner 已是 1.4，removeWhen 即「agent 配置读取收敛为 port 注入」） |
| 路由层测试 | **补关键边界用例**（model-management 的两个 `/api` 工厂、observer 的人员树 service/repository） |

#### 6.11.6 编排者独占的改动（安全修复、死代码与依赖声明）

以下改动落在「共享文件 owner」或跨包位置，由编排者独占执行，避免与逐包 agent 抢同一文件：

1. **security：channel `PATCH /web/channels/bindings/:id` 越权写入**（`src/server/routes/web/channels.ts`）。原实现只校验**原绑定**的 `target.agentId` 是否属于调用者组织，随后把请求体直接写库——请求体里的 `agentId` 是这次写入的**新**目标，同样是不可信输入。结果：任何已认证用户都能把自己的绑定改写到其它组织的 Environment，写库已经发生，响应还会把该组织的环境名回显（`environmentLookup.getById(updated.agentId)`），并把后续 Hermes 入站消息投递到该环境（越权写 + 组织信息泄露 + 跨租户消息投递）。修法：新 `agentId` 与 POST 用同一口径校验归属，拒绝时在校验阶段返回 404，**不得先落库再报错**。用例见 `src/__tests__/round54-channels-routes.test.ts` 的两条（拒绝跨组织改指且 `update` 调用数为 0；允许改指本组织环境并回显新环境名）。
2. **security：memory 7 个 `:id` 代理端点的路径段编码**（`src/server/routes/web/hindsight.ts`）。原实现把 `params.id` 原文插进上游 URL。Elysia 会把 `%2f`、`%2e` 解码进 `params`，`proxyToHindsight` 又直接 `fetch(url + path)`，而 `fetch` 对拼接结果做点段归一化——`/v1/default/banks/{bank}/` 前缀因此可被 `../` 穿透，越权读写同一 Hindsight 主机上他人 bank 的记忆、文档、心智模型与实体。修法：与 `bankPath` 里 bankId 的处理同口径，统一过 `segment()`（`encodeURIComponent`）。合法 id（UUID 等）编码后逐字不变，是纯收窄。用例断言「归一化后的 pathname 仍落在本 bank 前缀下」+ 遍历全部 7 个端点（方法必须与真实定义一致：`documents/:id` 只有 `DELETE` 没有 `GET`）。
   - 探针结论（两类缺陷的判据）：Elysia `/:path` 与 `/:id` 都会把 `%2F` 解码成 `/`；`new URL("http://h/../../admin").pathname === "/admin"`，且 `fetch` 同样归一化。
3. **删除死代码与死副本**：`packages/resources/channel/src/server/repositories/channel-binding.ts` 的 `findByChannelAndAgent`（零消费方，参数名 `channelId` 绑在主键列上）；`apps/server/src/schemas/api-workspace.schema.ts`（machine 包内同名文件的字节重复、宿主零消费方）；`apps/web/src/__tests__/task-form-schema.test.ts`（自包含副本，已与包内唯一 owner 漂移）。
4. **依赖声明补齐**：`@fenix/resource-mcp` 补 `drizzle-orm`；`@fenix/resource-skill` 补 `gray-matter` / `js-yaml`；`@fenix/agent-config` 删除 devDependencies 里零导入的 `@fenix/core`。此前它们靠仓库根 hoisting 偶然解析。`bun run check:dependencies` 由「24 条已登记例外」收敛后仍为 0 条新增违规。
5. **类型订正**：`DeleteChannelBindingResponse` 由 `Record<string, unknown>` 改为 `null`（服务端固定返回 `{success:true,data:null}`，调用方按对象访问只会拿到 `undefined`）。
6. **machine README 补丁清单第 4 条按实测改写**：原先还列 `apps/server/src/schemas/api-workspace.schema.ts`，该文件已删；同时补记「删 `./server/schema` 出口」与「改指包根」必须同批评估的反向代价（barrel 里是值导入，改指会把整图拉进宿主 schema barrel）。
7. **security：workflow `/workflow-ui` 静态代理的路径穿越**（`src/server/routes/web/workflow-proxy.ts`）。原实现 `targetPath = "/" + params.path` 后直接 `fetch(\`${acpxGUrl}${targetPath}\`)`。Elysia 1.4.30 实测把段内 `%2F` 解码进 `params.path`（请求 `/workflow-ui/..%2F..%2Fadmin` → `params.path === "/../../admin"`，`%2e%2e%2f` 同样解码），而 `fetch` 解析拼接结果时归一化点段——客户端无需上游配合即可让代理读取内部 `acpx-g` 的同源任意路径（`/workflow-ui/..%2F..%2Fadmin` → 上游 `GET /admin`）。与 §6.11.6 第 2 条（memory）同类，且这条不需要上游解码配合，故按安全缺陷修：新增 `isSafePathSegment` + `buildTargetUrl`，按「解码后逐段白名单」拒绝 `.` / `..` / 空段 / 分隔符 / 控制字符，重新逐段编码，并对最终 URL 做前缀 + 同源双保险校验，越界返回 400 且不回显被拒路径。新增 `src/__tests__/workflow-static-proxy.test.ts`（5 例：根路径与合法单段仍转发、编码斜杠夹带点段被拒且零上游请求、各种编码形态一律拒绝、未认证被守卫拦下且零上游请求）。**附带实测事实**：`:path` 只匹配单个 URL 段，因此带字面 `/` 的多级资源路径本来就不进处理器（404），修复不影响现网可取到的资源形状；`params.path` 带前导 `/`。
8. **迁移台账同步两处删除**：本任务删除 `apps/server/src/schemas/api-workspace.schema.ts`（§6.11.6 第 3 条）与 `apps/web/src/__tests__/task-form-schema.test.ts` 后，`scripts/__tests__/rmd-07-migration.test.ts` 的 `RMD_07_MOVES` 与 `rmd-08` 的 MOVES 会因「宿主目标不存在」变红。按台账既有形状把两条移入对应的 `*_RELOCATED` 三元组（旧根路径消失 + 宿主副本消失 + 包内 owner 存在），MOVES 68→67 / 172→171、RELOCATED 2→3 / 8→9，并在注释里写清每条的原因。实测 `bun test scripts/__tests__/rmd-07-migration.test.ts scripts/__tests__/rmd-08-migration.test.ts` → 7 pass / 0 fail。

#### 6.11.7 逐包补齐（实施明细，第一波 2026-09-20）

第一波按 §6.11.2 的发现逐包实施，13 个包共 12 个 agent（machine 无 agent，由编排者直接改，见 §6.11.6 第 6 条）。每包自证口径统一为 `env -u ANTHROPIC_MODEL bun test packages/resources/<pkg>` + `bunx biome check packages/resources/<pkg>`，均由本节的数值记录；其中 11 包的实现有独立验证 agent 复跑取证，裁定见下表的「验证」列（12/12 返回，CONFIRMED 7 / PARTIAL 5 / REFUTED 0；5 项 PARTIAL 全部只差在自述措辞或残留项，无一项否定落地事实，其余措辞偏差与残留缺口在第二波修复，见 §6.11.10）。

| 包 | 改动文件 | 落地内容（要点） | 自证 | 验证 |
|---|---|---|---|---|
| sandbox | 8 | route→route 依赖边拆除（`mapSandboxClusterAdminError` 移到 `src/server/error-mapping.ts`，`src/server.ts` 转出）；旧路由树 `src/routes/**` 删除；新守卫用例「路由模块之间不存在相互依赖边」 | 107 pass / 0 fail | CONFIRMED |
| channel | 8 | 列表持久 error/无权限分支 + 重试（纯判定模块 `web/lib/channel-list-state.ts`）；删除成功 toast；`aria-busy`、`group-focus-within`、3 处 `htmlFor`；README 边界残留与 i18n 无消费点清单钉进测试 | 200 pass（基线 193） | PARTIAL |
| knowledge | 11 | 删死副本 `agent-editor-knowledge.css`；新增 `agent-knowledge-access-denied.tsx`（`role="alert"`、无重试按钮）；补齐 3 处成功 toast 与 2 处图标按钮 `aria-label`；字典 243→245 叶键 | 416 pass / 0 fail | PARTIAL |
| prod-view | 7 | 列表失败不再落空态（持久 error + 重试）；3 个页面/面板的状态分流；新增渲染级用例 `prod-view-list-states.test.tsx` | 112 pass / 0 fail | CONFIRMED |
| mcp | 10 | 弹窗详情失败态与目录无权限态；`isUnauthorizedError` 纯逻辑用例；i18n 与宿主接线行号订正 | 283 pass / 0 fail | CONFIRMED |
| observer | 11 | 日志下载收口到统一错误归一（不再裸 `fetch` 后静默失败）；人员树 service/repository 行为用例 | 83 pass / 0 fail | CONFIRMED |
| memory | 16 | 7 个 `:id` 代理端点路径段编码（§6.11.6 第 2 条）；新增 `toHindsightFailure` + `HindsightFailureNotice`（无权限不给重试）接入 5 处；3 个 i18n 键 | 107 pass / 0 fail | PARTIAL |
| agent-config | 1 | README 已失效条目订正（跨包消费方用例可求值、i18n 子路径） | 347 pass / 0 fail | CONFIRMED |
| task | 9 | 列表失败不再退化「暂无任务」；无权限分支（标题 + 原因 + 后续动作）；渲染级用例 `task-list-states.test.tsx` | 320 pass / 0 fail | CONFIRMED |
| model-management | 14 | 用量页失败分流（`classifyUsageFailure`）与垂直模型筛选抽为纯模块；两个 `/api` 工厂补边界用例（守卫 12 端点逐个 401） | 210 pass / 0 fail | PARTIAL |
| workflow | 11 | `WorkflowPage.tsx` 去掉 `window.history.pushState`（改 `router.invalidate()`）；版本整行键盘可达 + 5 条 a11y 用例 | 714 pass / 0 fail | PARTIAL |
| skill | 12 | `web/index.ts` 补全导出；`AgentSkillsPage` 七态补齐；新增渲染级用例 `agent-skills-page-states.test.tsx`；`gray-matter`/`js-yaml` 依赖声明 | 271 pass / 0 fail | PARTIAL |

**测试设施与口径上的四项跨包事实**（实现者主动披露，非验收缺口，登记后随 §1.6 收敛）：

1. **Radix 弹窗在 happy-dom 下不挂载**（skill 实测：portal 容器建立、内容为空），涉及「确认删除 / 提交表单」的用例改以同签名替身驱动数据流，弹层自身渲染在包内无覆盖，归属 §1.6 WebShell 宿主用例。
2. **`web/__tests__/happy-dom-window.ts` 是仓库第 4 份同因副本**（`apps/web` 三级相对路径被 `.dependency-cruiser.cjs` 判越界），收敛到 `@fenix/web-runtime/testing`，四份副本须同步修改。
3. **observer 的日志下载无法字面走 `request<T>()`**：该函数按文本消费响应体，会把二进制流转成 `SERVER_ERROR`。实现改为保留 `fetch` 但把错误统一归一为 `ApiError`（code 规则与 `request.ts` 一致），属任务允许的「等价的统一层」。
4. **渲染级用例的前置依赖**：`model-management` 与 `channel` 的 `package.json` 未声明 `happy-dom` / `react-dom`，而「不改 package.json」是硬约束，故把状态规则提到纯模块断言（`classifyUsageFailure` / `resolveChannelListState`），`role`/`aria` 只由类型检查与 i18n 键用例间接守护；两包 README 均写明移除条件（声明 DOM 依赖后补渲染级用例）。

#### 6.11.8 登记为后续的项（本任务按 §6.11.5 的裁决不动手）

1. **存量硬编码中文文案（口径级，非单包违约）**：迁移带入的页面里，用户可见中文仍直接写字面量、未走 `t()`。实测（注释感知扫描）：knowledge `EmbeddingModelManager.tsx` 43 处 / `AgentKnowledgeBasesPage.tsx` 21 处 / `RetrievalTestPanel.tsx` 10 处 / `ChunkDetailSheet.tsx` 1 处（共 75 处 / 4 文件），model-management `AlgorithmsPage.tsx` 163 处，agent-config `SiteFrame.tsx` 35 处，task 的 `describeCron` 非预设分支与 `validateCron`、`TasksPanel` 空态、`TaskForm` 时区提示。**影响面**：宿主 `fallbackLng: "en"`（`apps/web/src/i18n/index.ts:153`），英文用户会看到中文；各包 i18n 字典本身已达标（例如 knowledge 243 键、键集 en/zh 一致，宿主已登记），缺的是组件未消费。**移除条件**：随各包页面下沉与前端收敛批次统一过 `t()`；用户已裁决本任务「暂时不想动」，因此登记的是「该做但本次不做」，不是「无问题」。
2. **prod-view `GET /config/prod-views/:id` 的错误状态码自相矛盾**：处理器把失败信封以默认 200 状态回给 Elysia，被该路由自己声明的 `200: OkResponseSchema` 校验拒绝成 **422**，客户端拿到的是校验错误体而不是 `{success:false,error:{code:"NOT_FOUND"}}`。声明的 404 从未生效。属协议契约缺陷（非本任务引入），需 owner 复核是补 `404` 响应声明还是显式 `status(...)`。
3. **memory 两项交付能力在运行时不可达**：`ensureHindsightMcpServer` / `ensureBank` 全仓无生产调用方（`grep` 只命中自身与测试）。已核实**不是本轮引入**——迁移前的父提交 `fff5cdb` 上同样没有调用方。影响面：memory 的 bank / MCP 登记路径不可达。**移除条件**：要么由宿主或模块组合根接线，要么确认能力不需要后删除；需 owner 裁定，本任务不删（删除会改变包声明的交付面）。
4. **sandbox 的窄投影副本（保留）**：`web/src/api/system-organizations.ts` 与 observer 的 `web/api/system-people-tree.ts` 请求同一端点（`/api/system/people-tree/`），sandbox 侧只投影 id/name/slug。**不合并**的理由是包级环：`@fenix/resource-observer` 的 `dependencies` 已含 `@fenix/resource-sandbox`（observer 有 7 个生产文件导入 `@fenix/resource-sandbox/web`），反向引用会闭成浏览器侧环。本任务只修正了文件头那条已过期的理由（原文称「observer 的 `./web` 出口尚未登记」，现已登记），并在 README 登记。**移除条件**：组织目录的 owner（identity）提供无环的公开客户端后，删除本文件并把调用方改指 identity。
5. **§1.3(3) 后半段（Facade 生成已授权 LaunchSpec 再调 Runtime port）未实现，归 §1.4**：`AgentConfigFacadeApi` 只有 `list/get/getById/existsInOrganization/create/update/remove/restartInstances`；全仓 `AgentInstanceStarter` 0 命中；启动路径实际由 agent-runtime 自己读 `agent_config` 构建 LaunchSpec，**无 actor、不校验 `use` 动作**。台账 `agent-runtime-not-to-resources` 的 owner 已是 1.4，`removeWhen` 即「agent 配置读取收敛为 port 注入」。写在此处是为了不给维护者留下「Facade 已完整」的错觉。
6. **agent-config L2 PocketBase 透传的百分号编码路径（登记，未修）**：`routes/web/agent-site-association-routes.ts:176` 用 `url.pathname.indexOf(prefix)` 提取相对路径后拼 `/api/${relative}`，`relative` 来自**未解码**的 `pathname`，因此 `%2e%2e%2f` / `..%2f` 这类编码形式的点段会原样进入出站 URL。探针实测（本仓可复现）：`/apps/<uuid>/api/%2e%2e%2f%2e%2e%2fadmin` → 出站 `…/app-xxx/api/%2e%2e%2f%2e%2e%2fadmin`；而字面 `..` 形式的请求被路由层挡成 404，且 `params.id` 有 `z.string().uuid()` 校验、归属也校验过，故**能不能逃出该 app 的前缀完全取决于上游（PocketBase / Go）解码后是否再做 `path.Clean`**——这一步不在本仓，无法验证，因此不按安全缺陷修，只登记待 owner 复核。若复核为可利用，修法与 §6.11.6 第 2 条同口径（对每个路径段编码，而不是直接拼原文）。
7. **单文件 500 行红线是**口径级**存量问题，不是某个包违约**：实测 `packages/` + `apps/` 共有 **88 个** `.ts/.tsx` 文件超 500 行（含测试文件），其中 `packages/resources/**` 占相当比例，最大的几个是 `knowledge/src/server/services/knowledge-provider/ragflow.ts` 1477、`knowledge/src/server/routes/web/knowledge-bases.ts` 1442、`model-management/web/pages/admin/AdminModelGatewayPage.tsx` 1241、`knowledge/web/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx` 1240、`workflow/web/pages/workflow/components/NodeConfigCard.tsx` 1182、`memory/web/pages/hindsight/components/DataView.tsx` 1034、`skill/src/server/facades/skill-facade.ts` 518。全部为迁移带入的既有状态，本任务只登记不改（拆分属独立重构，且会与逐包 agent 抢同一文件）。**处置建议**：按「前端页面优先、后端 route/service 次之」分批拆分，随 §1.6 的页面收敛与各包后续维护同批推进；不要以「超一行为由」在无关改动里顺手拆。
8. **`./server/schema` 出口的形状统一**：`@fenix/resource-{knowledge,machine,mcp}` 各有一个 `./server/schema` 子路径出口，消费方都是宿主 `apps/server/src/schemas/index.ts` 这一个 barrel。删除出口与「改指包根」必须同批评估——barrel 里是**值导入**（zod schema），改指包根会把整包 server 图拉进宿主 schema barrel；`./server/schema` 的存在意义正是给这条路径留一个窄口。machine 的条目已写进其 README（§6.11.6 第 6 条），三个包应一起定夺，owner 归 §1.4/§1.7 的表定义收敛。
9. **仓储层用例口径（13 包 7 有 / 6 无）**：`machine / memory / observer / sandbox / task / channel` 的 `repositories/*.ts` 无对应用例。这不是 channel 独有缺口，而是**口径级**事实：全仓没有任何资源包对 repository 跑真 Postgres SQL，`stubDb()`（`packages/platform/platform-sdk/src/testing/db-stub.ts`）是平台提供的 seam，用例只替换 `select/from/where`；§1.3 的验收口径也不含仓储层用例（静态 8 条 + 动态「包测试全绿 + 授权/隔离边界用例」）。登记在此是为了让后续 owner 在「要不要给 repository 补用例」上做一次统一决策，而不是逐包发现一次补一次。
10. **跨任务文档的路径漂移（三份，均非 §1.3 交付物）**：13 个资源包的路由目录统一为 `src/server/routes/**`（计划 §2.3），但有三份更早的文档仍指向 `src/routes/**` 或已删除的宿主文件——
    - `docs/arch/root-source-owner-inventory.md:53` 的 `packages/resources/sandbox/src/routes/api/sandbox` 等 4 条（该文件是 `scripts/check-root-source-owner-inventory.ts --markdown` 的生成物，但门禁**只比对「文档 == 规则表产出」，不校验目标路径是否存在**，故实测 `--check` 仍 `files=0 unowned=0 ambiguous=0` 通过；规则表记的是 RMD-02/03/04 当时的落点，属历史记录，改不改需 owner 定夺）；
    - `FUNCTIONAL_MODULE_INVENTORY.md:54/104` 的 `packages/resources/sandbox/src/routes/api/sandbox*.ts`，`:101/102` 的 `machine/src/routes/web/{registry,fs,file-events}.ts`，`:49` 的 `model-management/src/routes/**` 与 `apps/server/src/routes/web/config/providers.ts`（该宿主文件已由 Provider 资源包接管并删除）——实测这 4 类路径全部不存在，且无任何测试读取该文档；
    - 前一节的 `scripts/__tests__/rmd-07-migration.test.ts` 注释里同样留着 `packages/resources/sandbox/src/routes/web/sandbox-pools.ts`（第 115 行的原因说明文本，不影响断言）。
    逐一改正需要通读 `FUNCTIONAL_MODULE_INVENTORY` 全表（100+ 行）才能保证不留下半新半旧，属文档成批同步，登记后随 §1.6/§1.7 的文档收口一起做。
11. **沙盒包内旧路由树的删除未写进 README**：`packages/resources/sandbox/src/routes/**`（HEAD 上 5 个文件）是本包路由目录的旧落点，W0/W2 把路由移到 `src/server/routes/**` 后旧树一直留着，本任务按 §1.3(1)「不保留旧→新重复实现」删除。删除本身已由新加的包内守卫覆盖（`sandbox-source-migration.test.ts` 的「路由模块之间不存在相互依赖边」用例 + 迁移对的包侧路径全部改指 `src/server/routes/**`），但 README 未记这一条。**注**：`RMD_07_MOVES` 的 `["src/routes/web/sandbox-pools.ts", ...]` 指的是宿主 `apps/server/src/routes/web/sandbox-pools.ts`，与包内旧树无关，不受影响（已实测台账仍 7 pass / 0 fail）。
12. **包内 web 源文件与测试文件不在任何 tsconfig 的 `include` 内**（实测：根 `tsconfig.json` 仅 `["apps/server/src/**/*.ts"]`；`apps/web/tsconfig.json` 仅 `fenix.module.ts` + `src/**` + `components/**`；13 个资源包也不各自持有 `tsconfig.json`）。因此包内 `web/**` 只通过 `apps/web/src` 的**传递导入**被间接类型校验，**没有任何测试文件被校验**（`bunx tsc -p apps/web/tsconfig.json --noEmit` 对 `packages/resources/mcp/web/__tests__/*.tsx` 的报错数为 0，即使该文件存在真实类型问题也不会被门禁发现；`bun test` 不做类型检查）。本任务新增的渲染级用例（含 5 个包的 `*-states.test.tsx`）因此只有运行时保障。**移除条件**：为资源包补 tsconfig 并把 `web/**` 纳入类型门禁（与 §1.6 的包内 web 收敛同批），或把测试文件纳入 `apps/web` 的 `include`。
13. **Bun `mock.module` 的进程级污染**：见 §6.11.11（含 `--isolate` 的根治建议与用户裁决）。

#### 6.11.9 门禁证据

**收口命令与结果（本任务定稿状态）**

| 命令 | 结果 |
|---|---|
| `env -u ANTHROPIC_MODEL bun run precheck` | **exit 0，12/12 步全绿**（合计 89904ms）：format 486ms / import-sort 681ms / module-registry 211ms / architecture 795ms / tsc(server) 4415ms / tsc(web) 9824ms / tsc(app skeletons) 13377ms / dependency-boundaries 4484ms / lint 814ms / server-and-script-tests 4871ms / **package-tests 48061ms** / web-app-tests 1878ms |
| `bun test packages/`（门禁第 11 步的同一命令，单独复跑） | 7274 pass / 2 skip / 0 fail，593 文件，46.6–48.8s |
| `bun run build:web` | exit 0，`✓ built in 1.82s` |

`env -u ANTHROPIC_MODEL` 是必要前提：本机 shell 注入的 `ANTHROPIC_MODEL` 会让 acp-link 的 8 个用例失败，与本任务无关（已记入记忆）。

**非确定性失败记录（按「非确定性失败需要重复时记录原因和证据」）**

编排者收口阶段共执行 **10 次**全量 `bun test packages/`（含 2 次 precheck 内的同命令），**2 次失败，且两次失败的用例不同**：

| 次 | 出处 | 失败用例 | 该用例耗时 | 单跑结果 |
|---|---|---|---|---|
| 1 | precheck 的 package-tests | `packages/workflow-engine/src/__tests__/executor/sub-workflow-executor.test.ts` →「子流程失败时已 spawn 的实例仍保留在父级集合」 | 67639ms | 18 pass / 0 fail（2.2–2.7s，连跑 3 次） |
| 2 | `bun test packages/` | `packages/resources/machine/src/server/__tests__/fs-etag.test.ts` →「rename 后 tree ETag 变化（路径 hash 参与指纹）」 | 11382ms | 所在包单跑 657 pass / 0 fail（16.1–17.1s，连跑 3 次） |

两次失败的可观测共性：都发生在**整轮更慢的那几次运行**（112.5s / 58.9s，对照 8 次全绿为 46.6–48.8s），且失败用例耗时是其单跑耗时的 4–25 倍；两个用例都依赖真实计时（前者是 AgentExecutor 的指数退避重试，后者要在两次 tree 请求之间观察到路径集合变化）。异常都落在**本任务未改动的包**：`workflow-engine` 在本次工作区里零改动（`git status` 空），`fs-etag.test.ts` 的**断言体也零改动**（`git diff` 只有导入改指、路由工厂化与加锁三处夹具改动）。

**判定：高负载下的计时抖动，不是某处改动的确定性缺陷。** 判据有三：（a）两次失败用例互不相同，且各自单跑稳定通过；（b）失败后连续 8 次全量 0 fail；（c）定向复现不成立——把 `machine` 与两个不参与根锁的包（`plugin-ccb` / `plugin-opencode`）混跑 6 次，735 tests × 6 全部 0 fail，「跨文件改根导致 ETag 误判」这一假设**未获证实**，故不作为结论写入。

**本轮据契约缺陷做的两处加固（不宣称是上述抖动的根因，两者都没有被复现证据支撑为成因）**

1. `packages/resources/machine/src/__tests__/fs-symlink-escape.test.ts`：「WORKSPACE_ROOT 本身为 symlink 时读写正常」用例在运行中把根切到软链目录，却直接写 `process.env.WORKSPACE_ROOT`——违反本任务引入的根锁契约（`workspace-root-lock.ts` 明文要求「含按用例切换根的」必须经锁）。改为先 `unlock` 释放本文件 `beforeEach` 持有的根、再 `lock` 独占软链根（**不能**直接二次取锁：那会等自己的释放而空等到锁的等待上限）；`afterEach` 里的手动 `delete process.env.WORKSPACE_ROOT` 一并去掉，交由解锁处理。
2. `packages/platform/platform-sdk/src/testing/workspace-root-lock.ts`：`unlockTestWorkspaceRoot()` 此前无论是否持锁都会写根，一个从未取锁的用例（或同一文件里不参与锁的用例）在 `afterEach` 调用它就等于替并发持有者改根——正是本锁要排除的争用。改为**未持锁时是空操作**；`file-ws-events.test.ts` 那种「只有一组用例持锁、其余不参与」的写法随之不再可能误删他人的根（该文件的手动 `delete` 同步移除）。现有 11 个调用点全部是「持锁后调用」且无一处传 `previous`，行为不变；改动后全量为 7274 pass / 0 fail。

**仍存在的、登记不动的风险**：`packages/plugin-ccb`、`packages/plugin-opencode`、`packages/agent-runtime/src/__tests__/workspace-resolver.test.ts` 会改 `process.env.WORKSPACE_ROOT` 而不参与锁。前两者所在类别不在依赖矩阵允许 `platform-sdk` 的集合内（工程标准 §2.3：`platform-sdk` 的依赖方是 `platform` 实现、`agent-runtime`、`resources`、`apps`），补锁必须先定依赖边界，不在本任务动手；后者是同步「设置并读回」，属锁契约明文豁免的形态。

#### 6.11.10 第二波：验证缺口修复与测试基础设施缺陷（2026-09-20）

第一波的 12 位验证者返回后，按其 `missing` 清单逐包修复（8 个工作项：skill、workflow-web、knowledge、model-management、task、mcp、channel、docs-stale），每项再由独立验证者复跑取证。裁定：**CONFIRMED 5 / PARTIAL 3 / REFUTED 0**，三处 PARTIAL 中两处只差在自述计数与措辞（model-management、mcp），一处是真实未达标（knowledge，见下）。

**本轮由编排者独占执行的两项改动**：

1. **security：`/workflow-ui` 代理的路径穿越**（§6.11.6 第 7 条）——含新建 `src/__tests__/workflow-static-proxy.test.ts`（5 例）。关键是这条与 memory 那条同类但**不需要上游配合**：Elysia 解出 `params.path === "/../../admin"`，`fetch` 归一化点段即可逃出前缀。
2. **迁移台账同步**（§6.11.6 第 8 条）——两处删除引起的 MOVES/RELOCATED 重排。

**mcp 弹窗文件「重建」疑点的裁定**：验证者无法证实实现者「按捕获内容逐字重建」的说法（自述称改动前 473 行，而 HEAD/暂存版均为 457 行、`git fsck` 的 dangling blob 与 8 个 stash 里都没有含 `setDetailError` 的版本）。编排者逐 hunk 复核了该文件的 `git diff`：62 插入 / 26 删除全部落在本次委派的三件事上——导入改指包入口（`@/components/*` → `@fenix/ui-components/*`、`@/src/api/mcp` → 相对路径）、`detailError` + `reloadKey` + `hideSubmit={readOnly || detailError !== null}` 的新增错误分支、以及键值行由数组下标 key 改为稳定行 id（顺带修掉一个真实缺陷：中间行删除会把 DOM 状态错配给上一行、编辑时逐字重挂载丢焦点）。**无一行无法解释**，故「473」判为实现者的计数笔误，不构成内容丢失；该结论替代验证者的不可证实判定。

**knowledge 未达标项（真实缺口）**：新增的两个渲染用例（`agent-knowledge-bases-page-states.test.tsx`、`knowledge-panel-load-failure-states.test.tsx`）用**真实 react-i18next 实例**驱动断言，因此在全量同进程下拿到泄漏替身而整批变红；实现者已把该偏离写进 README 与 blockers，但按委派硬性判据（「同进程混跑也 0 fail 才算通过」）属未达标。README:13 的叶键计数（55/245）也未与同文件 :44/:105 的实测值（56/247）同步。

#### 6.11.11 系统性发现：Bun `mock.module` 是进程级的，渲染用例会跨包互相污染（登记，不在本任务重构）

第一波与第二波各新增了若干 `.tsx` 渲染用例后，仓库门禁命令 `env -u ANTHROPIC_MODEL bun test packages/` 从绿转红，实测 **47 fail**（`packages/{agent-runtime,resources/{channel,knowledge,mcp,model-management,observer,prod-view,task,workflow}}/web/__tests__/**`），而其中**任何一个文件单跑都是 0 fail**。

**根因（已用最小实验确认，非推测）**：

1. Bun 1.4.2 的 `mock.module()` 注册是**进程级**的。`bun test packages/` 在单进程内按包路径顺序执行文件，某个文件在模块作用域注册的替身会泄漏给其后的所有文件；只有后续文件**自己重新注册**同一模块时才拿回自己的替身（实验：a.test.ts 注册 `MARKER: "A"`、b.test.ts 注册 `MARKER: "B"`，两者各自看到自己的值 → 同文件内自注册有效）。
2. `afterEach(() => mock.restore())` **不能**阻止泄漏（实验：注册替身并在 `afterEach` 调 `mock.restore()` 的文件之后，一个无任何 mock 的文件仍能读到该替身）。仓库里 `packages/agent-runtime/web/__tests__/file-picker-panel.test.tsx:12-13` 同样有 `afterEach(mock.restore())`，正是它注册的 `t: (key) => key` 泄漏给后续文件。
3. 由此产生两类失败：**link 期报错**——`packages/resources/knowledge/web/__tests__/agent-knowledge-bases-page-states.test.tsx:44` 的 `@tanstack/react-router` 替身只有 `useNavigate`/`useSearch`，泄漏后使之后加载的组件（用 `<Link>`）在导入期抛 `SyntaxError: Export named 'Link' not found`，整批用例 0.05ms 级全红；**i18n 回显**——依赖真实 react-i18next 实例的文件拿到 `t: (key) => key` 的替身，断言里的中文文案变成 i18n key。
4. 影响面是**跨包**的：一个包的文件可以打崩另一个包的用例，且顺序由包路径决定（`channel` < `knowledge` < `mcp` < … < `task` < `workflow`），所以「新加一个文件」随时可能让无关包变红。
5. **第三类失败：UI 外壳替身被跨包顶替**（专项修复时实测新增）。剩余失败全部收敛到 `@fenix/ui-components/config/{FormDialog,ConfirmDialog}`——更早的文件把它们注册成「什么都不渲染」或「只透传 children」的最小替身，其后的页面 import 到的就是那份替身，弹窗内容整块消失。逐模块 bisect 单独导入都不复现，复现只取决于注册顺序。**注意反向委托不可行**：真实组件的 `useTranslation` 绑定在首次求值那一刻，`packages/ui-components` 的 barrel 用例已先用真实 `react-i18next` + demo 字典求值过它，此后翻译替身对它失效。处置见 §6.11.12。

**处置（用户裁决，2026-09-20）**：「如果是 mock 污染导致失败的用例可以直接删除」——据此优先补齐替身面（让泄漏无害：`@tanstack/react-router` 替身给跨包组件所需的并集导出、`react-i18next` 给 `useTranslation`/`I18nextProvider`/`initReactI18next`、`sonner` 给 `toast` 的五个方法）与让用例**自持**翻译表替身，仍无法稳健的用例按裁决删除，具体清单见 §6.11.12。

**建议的根治方向（登记，不在本任务做）**：Bun 已提供 `--isolate`（「每个测试文件一个全新 global 与模块注册表，一个文件的泄漏句柄不影响另一个」），`--parallel` 隐含它。把门禁的 `bun test packages/` 改为带 `--isolate` 即可一次性消除这一整类跨文件污染，代价是每个文件重新初始化模块（变慢）与改动门禁命令本身（`scripts/ci.ts:85`、`.github/workflows/ci.yml:67`，CI 的 bun 已是 1.4.2，支持该 flag）。属测试基础设施决策，需与 §1.4/§1.6 的测试入口收敛一起定夺；本任务只登记。

#### 6.11.12 第二波删除的用例清单

**结论：删除数为 0，未启用用户授予的「污染用例可直接删除」裁决。** 专项修复（5 个文件，全部在 `packages/**` 的测试文件内，未动任何生产代码）把每条失败用例都修活，因此不存在因删除而失去覆盖的 §1.3(6) 状态；`bun test packages/` 的用例总数由修复前的 7227 pass / 47 fail 变为 **7274 pass / 0 fail**（+47 即全部复活）。

| 文件 | 策略 | 改动要点 |
|---|---|---|
| `packages/resources/mcp/web/__tests__/mcp-page-states.test.tsx` | 自持替身 | 原先「委托真实组件」的包装式替身在污染进程里 `await import` 拿到的本身就是泄漏替身，反而整块不渲染；改为自带呈现的 `FormDialog` 同签名替身（渲染标题 / children / 取消 / 提交，`hideSubmit` 与 `loading`、`submitLabel` 口径对齐真实组件）。提交入口可达性正是该用例的回归点，未被弱化。 |
| `packages/resources/channel/web/__tests__/channel-list-error-feedback.test.tsx` | 自持替身 | 该文件原本不 mock 弹窗，被 skill / knowledge / workflow 泄漏的 `ConfirmDialog: () => null` 顶掉，「确认删除」按钮永远找不到；新增自带呈现的 `ConfirmDialog` 同签名替身（`open` 为假不渲染，打开时渲染标题 / 说明 / 取消 / 确认，标签优先取 `confirmLabel` / `cancelLabel`，否则回落到本文件翻译表）。 |
| `packages/resources/knowledge/web/__tests__/knowledge-panel-load-failure-states.test.tsx` | 自持替身 + 真实工厂回绑 | `dompurify` 把真实工厂绑回本用例的 happy-dom window（注册必须排在 `win` 之后——实测 bun 1.4.2 在注册时立即求值工厂，提前会命中 TDZ）；i18n 替身改走共用模块。 |
| `packages/resources/knowledge/web/__tests__/agent-knowledge-bases-page-states.test.tsx` | 共用替身 | 同一份 provider 感知的 i18n 替身改为共用模块（此前该替身必须尊重 `I18nextProvider` 传入的实例，否则 `knowledge-access-denied.test.tsx` 用空字典断言 key 回显会失真）。 |
| `packages/resources/knowledge/web/__tests__/react-i18next-stub.ts`（新增，73 行） | 共用替身模块 | 知识库两个用例共用的 `react-i18next` 注册器：`I18nextProvider` 透传调用方实例、`t` 按「实例 + 命名空间」稳定缓存（组件把 `t` 写进了 effect 依赖数组，换新函数会让 effect 反复重跑）、并补 `initReactI18next` / `Trans` 出口以免后续文件加载组件时抛错。抽出的直接原因是 `knowledge-panel-load-failure-states.test.tsx` 加入替身后到 544 行、超过单文件 500 行上限，抽出后 486 行（另一文件 355 行），同时消除两处替身口径漂移。 |

**第二波失败的完整根因（本轮实测新增，§6.11.11 的第 5 条）**：除已记录的 link 期 `SyntaxError` 与 i18n 回显两类之外，还有第三类——**UI 外壳替身被跨包顶替**。剩余失败全部收敛到 `@fenix/ui-components/config/{FormDialog,ConfirmDialog}`：同进程更早的文件把这两个模块注册成「什么都不渲染」或「只透传 children」的最小替身，其后的页面在测试期 import 到的就是那份替身，弹窗内容整块消失，`role="alert"` 与提交按钮都断言不到。逐模块 bisect（`ui/dialog`、`config/FormDialog`、`ChatView`、`app-page`、`AgentCardList`）单独导入都不复现，复现只取决于「哪些文件先注册过同名替身」，与 `bun test packages/` 的顺序一致。**反向委托真实组件不可行**：真实组件的 `useTranslation` 绑定在首次被求值的那一刻，同进程里 `packages/ui-components` 的 barrel 用例已先用真实 `react-i18next` + demo 字典求值过它，此后任何翻译替身对它无效（按钮会渲染成真实字典里的英文）。

**非确定性失败记录（按「非确定性失败需要重复时记录原因和证据」要求留存）**：会话内共跑 9 次全量，7 次 0 fail，2 次各出现 1 条与本次改动无关的计时抖动，均在未改动的包内且单跑必过——
- `packages/chat-channel/src/channel/command-coordinator-state.test.ts`「deltas are dropped while cancelling」超时（该文件单跑 3 次全过，450ms）；
- `packages/resources/machine/src/server/__tests__/file-ws-opid.test.ts` 熔断用例超时（同包 `fs-download-zip` 偶发一次）；出现该次全量耗时 146s（其余 47–84s），判为高负载下的 5s 默认超时抖动，用 `--timeout 30000` 跑同一全量为 0 fail（7274 pass / 2 skip），不在本轮改动范围内，不修改被测代码。

