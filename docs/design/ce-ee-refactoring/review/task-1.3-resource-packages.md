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

- `fenix.module.ts`：**0/13**；`README.md`：13/13 存在但 `agent-config` 仅 3 行占位；正确 `./web → web/index.ts` 形状：**1/13**（sandbox）。
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

**W1 的强制点**：`machine` 注册 manifest 时，`sandbox` 必须同时补 `dependsOn: ["machine"]`，否则生成器直接失败；`machine` 侧的 `machine → sandbox` 反向边已登记为越界边（owner 1.4），因此不需要（也不允许）声明，方向与 §2.3 一致。

**T2 剩余项（尚未完成）**：T2b 浏览器面守卫递归跨包子路径；T2c 从 `./server` 移除 `getSandboxDatabase` / `SandboxDatabase` 公开导出；T2e web 第三方依赖声明规则（peerDependencies）；T2f 重写假绿的 `sandbox-source-migration.test.ts` 与 `guard-stubs.ts` 的不实覆盖声明；T2g 删除 `apps/web/src/__tests__/system-sandbox.test.ts` 重复副本、admin-key 迁入 `@fenix/web-runtime`。
