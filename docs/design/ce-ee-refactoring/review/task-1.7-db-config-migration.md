# 任务 1.7 评审记录：DB、配置、迁移与交付

> 权威要求：`ce-ee-refactoring-stage-2-plan.md:92-98`（1.7 五条）、`:100-105`（1.8 四条）；
> 验收标准：`ce-ee-engineering-standards.md` §10；依赖矩阵：同文 §2.3。
> 起点：`2e08ca422`（1.6 收口提交）。

## 一、范围与档位

用户裁定档位为「**缺陷 + 1.7 主体**」，即本批交付以下三类：

| 块 | 内容 | 状态 |
|---|---|---|
| A1–A6 | 6 类既有缺陷的修复 | 见 §七 |
| B | 业务表 schema 唯一真相迁至 owner 模块 + 清 14 条 `apps-boundary` 豁免 | 阻塞于 §四.1 裁定 |
| C | 模块 env 声明收敛（宿主统一读取、模块不直读 `process.env`）+ 17 个模块 `envDefinitions` | 阻塞于 §四.2 批 0 |

**本批不做、只登记**（清单与移除条件见 §八）：migration smoke、preflight / readiness、
SBOM / 备份 / 回滚、`deploy/compose/` 与镜像构建整理、关键 E2E，以及 **1.8 全部四条**
（日志与 ALS 规范、测试迁移与 CI 目录扫描、文档全量更新、最终证据）。

工作原则（用户原话）：「只要不违背规范，能不做的先不做」+「不留已知缺陷，只欠新设施」。
因此本档位的判据是：**凡属既有缺陷或 1.7 主体必需，必须在本批修完；凡属新设施或 1.8 范围，
登记为未完成**，不以「顺手做掉」扩范围。

## 二、现状实测

任务书文本与实测不符之处（均以 `git grep` / 脚本实测为准，不采信任务书数字）：

| 项 | 任务书 | 实测 |
|---|---|---|
| schema 消费者文件数 | 94 | **108**（含真实 import 的 63 个：生产 50/51 处、测试 13/15 处） |
| 业务表张数 | 39 | **40** |
| 包边界豁免条数 | 14 | 14 条 owner=`1.7`（`apps-boundary → @fenix/server-app`）+ **15 条 owner=`未排期`** |
| 跨包 schema 引用边 | 未提及 | `.references()` 45 处，其中**跨包 28 条**（17 → identity 的 `user`/`organization`，11 在资源包之间） |
| 模块 env 声明数 | 17 个模块需声明 | 17 个 manifest **全部没有** `envDefinitions`（生产声明数为 0） |
| 「模块直读 `process.env`」规模 | `agent-runtime` 16 处 / `logger` 5 处 | `packages/**` 167 命中中真实代码读取仅 **54 行**；server 装配面内唯一真违规是 `packages/agent-runtime/src/server/services/workspace-resolver.ts:9` 的 `WORKSPACE_ROOT` |

`scripts/ci.ts` 在本批前为 **13 步**；A5 把 `owner-inventory` 补入后为 **14 步**（其中
`tsc(app skeletons)` 与第 6/7 步逐字重复，属既有冗余，见 §八）。

## 三、用户裁定（2026-09-21）

1. **收尾档位**：缺陷 + 1.7 主体（§一）。
2. **日志脱敏不做**：「日志脱敏不用做，不需要这个功能」。据此 **A1 整批撤回**（§7.1），
   prompt 与 Agent 输出继续截断后打入日志，作为已知缺口登记（§八）。

## 四、执行期裁定

执行期裁定是按实测证据 + 计划文本作出的判断，**可被推翻**；逐条给出依据。

### 4.1 B 块：跨包 schema 导入与 §2.2:105 的冲突（**已裁定：路径作用域例外**）

`ce-ee-engineering-standards.md:105` 逐字规定：「调用方不得导入 `@fenix/skill/src/services/*`、
B 的 repository 或 **db/schema**」。而 1.7 第①条要求 40 张业务表的唯一真相迁到 owner 模块，
表间 28 条**跨包**外键是 Drizzle `.references(() => otherTable.col)` 形式的**值引用**
（Drizzle 无字符串/延迟解析形式），全迁就必然出现「资源包 A 的 `db/schema.ts` 导入资源包 B 的
`db/schema.ts`」——与上述条款直接冲突。

属「导致职责、数据流或公共契约变化的决定」，按 CLAUDE.md 必须先反馈，不得自行选择。

**用户裁定（2026-09-21）：允许 `db/` 跨包导入。** 新增一条**路径作用域**门禁，只放行
`packages/**/db/**` 下对其他模块 `db/schema.ts` 表对象的导入；`src/**` 与 `web/**` 的跨包导入照旧
违规，`agent-runtime` 的既有禁则同步限定到 `src/**`。落地见 §7.9，权威设计同步见
`ce-ee-engineering-standards.md` §2.2 / §2.3 / §6.1 / §10.2 第 2 条。

**为什么落成路径例外而不是台账条目**：台账的匹配粒度是**包对**（`(rule, from, to)`）。一条
「`@fenix/resource-agent-config → @fenix/platform-identity`」的 schema 例外会连同该包的
`src/**` 一起放行，等于废掉 §2.3 对这两族之间的整条禁则；`db/**` 的路径判别才能把例外限定在
「表达外键的组装期」这一件事上。该决定同时决定了 B 块各批**不能**靠新增台账条目来过渡。

### 4.2 C 块：必须先做批 0，否则补声明是空转

`apps/server/src/main.ts:35` 的 `loadServerEnv([])` 是 `buildModuleConfigs()` 的输入，而
`bootstrapModules` 内部按各模块 `envDefinitions` 加载的那份 env **不回流到 `moduleConfigs`**。
因此今天给 17 个模块补 `envDefinitions` 对宿主接线**零效果**：既不产生校验，也不改变注入。
批 0（打通回流通道）是 C 块其余批次的前置，不是可选优化。**已于 `cb0c5976c` 交付（§7.8）**。

### 4.3 A2 白名单规格的一处修正（静态门禁正则）

规格建议的检测正则 `/(^|[\s{,(])\.\.\.\s*\(?\s*(process|Bun)\.env\b/` 有一处真实误报：
`packages/acp-link/src/server.ts:190` 的 `...(process.env.CLAUDE_CODE_CLI_PATH ? [{...}] : [])`
展开的是**数组**、不是宿主环境本体。落地时在末位加否定断言 `(?!\s*[.[])`（排除「展开成员访问
结果」的形态）而非废弃规则，并以 `scripts/__tests__/dependency-boundaries.test.ts` 的 2 条
单测固定该行为，避免下次改动重新引入误伤。实测全仓 `packages/**/src/**` 零误伤、零命中。

### 4.4 A5：`owner-inventory` 必须进 precheck，不只是 CI

`scripts/ci.ts` 是 precheck 的执行体，`.github/workflows/ci.yml` 是另一条入口。补 CI 而不补
`ci.ts` 会让 precheck 比 CI 宽松（本机绿、CI 红），因此两处同步补，`ci.ts` 从 13 步变 14 步。

### 4.5 A6：清单文档的历史规则表用「声明式补救」而非改规则

`docs/arch/root-source-owner-inventory.md` 的过期行来自 `scripts/root-source-owner-rules.ts:866`
（RMD 声明式迁移规则的历史快照）。规则文件不在 A6 授权范围，且 `review/task-1.6-web-shell.md`
§7.26 / §7.30 已把该条保留为「当时判定」的记录。故按仓库既有先例（`docs/design/2026-09-18-*.md`
的「首行标注快照性质」）在生成器模板插入「历史快照」声明后**重新生成**，未手改文档。

### 4.6 A6 的越界项：CLAUDE.md 的过期路径由主控一并修正

A6 报告 `CLAUDE.md:54`、`:127` 仍指向 `apps/web/src/api/request.ts`（该文件已不存在，真身
`packages/web-runtime/web/api/request.ts`）。按「文档与代码不一致时同步修正文档」并入本批（§7.4）。

### 4.7 B 块批次序：按**跨包外键拓扑序**，不按包名或表数

原计划的 B1=memory 不可行：`agent_memory_config.agent_config_id` 的外键指向 `agent_config`，而
`agent_config` 要到 B7 才迁出，`memory/db/schema.ts` 无处可导入。改用实测 FK 图（49 张表 / 52 条
FK；identity 9 张已随任务 1.2 迁出，业务 40 张待迁）按包名语义归 owner 后做拓扑排序，得 13 批：

| 批 | 包 | 表 | 依赖（跨包外键） |
|---|---|---|---|
| B1 | machine | `machine`、`registry_event` | — |
| B2 | mcp | `mcp_server`、`mcp_tool` | — |
| B3 | model-management | `model`、`model_gateway_credential`、`provider` | — |
| B4 | sandbox | `sandbox_instance`、`sandbox_pool` | — |
| B5 | skill | `skill` | — |
| B6 | workflow | 9 张 | — |
| B7 | agent-config | `agent_config`、`agent_config_mcp`、`agent_config_site_app`、`agent_config_skill`、`agent_site_app` | machine / mcp / model-management / skill |
| B8 | agent-runtime | `agent_instance`、`environment` | agent-config |
| B9 | knowledge | `agent_knowledge_binding`、`knowledge_base`、`knowledge_resource` | agent-config |
| B10 | memory | `agent_memory_config` | agent-config |
| B11 | prod-view | `prod_view` | agent-config |
| B12 | task | `scheduled_task_v2`、`task_execution_log` | agent-config |
| B13 | channel | `channel_binding`、`im_channel`、`im_channel_route` | agent-runtime |

指向 identity 的 18 条外键（`user` 17 条 + `organization` 1 条）不构成约束：identity 表已迁出且
其它模块按 §6.1 导入 `@fenix/identity/db` 表达。D3 裁定留在宿主的 3 张表（`resource_permission`、
`share_link`、`share_event_snapshot`）与 3 个 pgEnum **不参与**批次——它们无 owner，也没有任何 FK
指向它们，因此既不阻塞也不被阻塞，宿主 `schema.ts` 因此**无法完全清空**（§8.1 登记）。

### 4.7.1 每批交付面（B1 实测 + 对抗式审计补充）

原口径「新 owner 文件 + 本包读取点 + 全部跨包读取点 + `drizzle.config.ts` + 文档」经审计补四项，
后续 12 批**逐批**适用：

1. **调用期读取点必须改为经 owner 的公开入口或宿主注入端口取数**，不是把 import 改指 owner 的 `./db` 出口（§4.8 第 4 条）。**作用域是 `packages/**`**：本条判定依据是 §2.2 / §2.3 的包级依赖矩阵，属 packages 域禁则；**宿主（`apps/server/**`）经 owner `./db` 出口读写别的包的表对象不在收口范围内**——它是唯一同时持有全部 owner 表定义的装配层（与宿主 `schema.ts` 表达跨包外键同一条理由），且部署期数据迁移是一次性的。**裁定（用户，2026-09-21）：登记为 carve-out**，逐条落点见 §7.11。
2. **`package.json` 依赖声明**：owner 包的 `db/schema.ts` 每导入一个跨包表对象，就必须声明该表所在包
   ——§6.1 的 `db/` 例外只豁免 `special-dependency`，`undeclared-workspace-dependency` 不豁免（§4.8 第 5 条）。
3. **该包的 source-migration 契约测试**：含「`@server/db/schema` 残留数 > 0」正向控制的用例当批必然
   失败，需同步收缩（§4.8 第 6 条）。
4. **调用期跨包写**：两处需在对应批次一并处理（§4.8 第 7 条）。

批级阻塞（开工前必须先定夺，均已反馈）：

- ~~**B4（sandbox）**：`machine → sandbox` 是 §2.3 类别禁则的硬违规~~：**已解除**——按 §4.8 第 3 条的裁定，
  投影写路径已移到 sandbox 侧并作为 B4 前置独立交付（2026-09-22，见 §7.13）。B4 主体因此回到「只搬表定义」，
  并已于同日交付（见 §7.14）。
- **B7（agent-config）**：`agent-runtime` 两个文件在查询期 LEFT JOIN `agent_config`，迁表后会命中
  dependency-cruiser 的 `agent-runtime-not-to-resources`；且 D4「3 张 join 表归 agent-config」与现有
  实现冲突（§8.4 第 7、8 条）。

### 4.8 B1 实测：跨包表读取决定每批的**可完成条件**

第 1 批实施中实测到三件事，它们同时修正了后续 12 批的执行口径：

1. **迁表不只改本包。** 除 machine 包内 6 个文件外，还有 4 处**别的包**直接读 `machine` 表：
   `packages/resources/agent-config/src/server/services/agent-related-resources.ts`、
   `packages/agent-runtime/src/server/services/environment-web.ts`，以及两个测试文件
   （`agent-config/__tests__/round45-agent-config-routes-coverage.test.ts`、
   `sandbox/__tests__/sandbox-schema.test.ts`）。漏改任何一处都不是「少改一个 import」：
   `bunfig.toml` 的 preload 会加载 `apps/server/src/test-utils/setup-mocks.ts`，它经
   `@fenix/resource-machine/server` 间接加载 machine 包并在模块链接期抛
   `SyntaxError: Export named 'machine' not found`，**machine 包 45 个测试文件全部报错**。
   故每批的交付面 = 新 owner 文件 + 本包读取点 + **全部跨包读取点**（B1 实测 19 处，逐批余项见 §7.10）。
2. **`apps-boundary` 台账条目不能随批删除。** 该规则的判定是 `packages/**` 里任何
   `@server` / `@server/*` 说明符，台账按 **(rule, from, to) 包对**匹配。B1 后 machine 包仍有
   3 处跨模块表读取（`registry.ts` 读 `agent_config`、`machine-sandbox-projection.ts` 读
   `sandbox_instance`、`registry-schema.test.ts` 断言 `agent_config` 外键列），目标表分别在 B7 与
   B4 迁出。**提前删条目会把尚未迁出的读取一并放行**，所以删除时机是「该包最后一个跨模块表读取消失」，
   不是「该包自己的表迁完」。这决定了 14 条 owner=`1.7` 的豁免只能在 B 块**末期**集中清零。
3. **`machine → sandbox` 的表读取是硬违规，sandbox 批必须先定夺方案。** `machine-sandbox-projection.ts`
   把机器注册/心跳投影为实例状态，`sandbox_instance` 迁出后它不能改指 `@fenix/resource-sandbox/db`：
   §2.3 的类别禁则明确禁止 `machine → sandbox`，而 §6.1 的组装期例外只覆盖 `packages/**/db/**`
   路径，该文件在 `src/server/services/` 下不适用。B4 开始前必须在两条路里选一条——把投影写路径移到
   sandbox 侧（机器事件经宿主注入的端口回调），或由 sandbox 提供「按机器 ID 更新实例状态」的公开写入
   口——两者都超出「只搬表定义」的范围，按 CLAUDE.md 届时应先反馈。

   **裁定（用户，2026-09-21）：投影写路径移到 sandbox 侧。** machine 不再写 `sandbox_instance`；
   sandbox 包在自己的表上写，machine 只经宿主注入的端口 / 事件通知。无需为 `machine → sandbox` 新增
   依赖矩阵例外（§2.3 免改）。该重构要改 machine 的投影触发链，作为 **B4 的前置小任务**独立交付，
   不在 B 块的「只搬表定义」批次里做。

   **已交付（2026-09-22，见 §7.13）**：machine 侧新增 `machine-lifecycle-port.ts`
   （`notifyMachineRegistered` / `notifyMachineHeartbeat`），投影实现移到 sandbox 的
   `sandbox-instance-repository.ts`，由 `createSandboxModule()` 注入；`machine/src/**` 不再出现
   `sandbox_instance`，本包的两处跨模块表读取降为 1 处（只剩 `agent_config`，归 B7）。

4. **调用期跨包取数一经裁定为「调用公开函数」，但首轮实现被装配闭环挡死，最终落成宿主注入端口
   （2026-09-21）。** B1 原先把两处 `src/**` 调用期读取改指 `@fenix/resource-machine/db`，按 §6.1
   边界 1 **仍是违规**——「调用期只能经包根入口公开的 service / DTO 取数」，例外只在各包 `db/` 内成立。
   第一轮按裁定改成 machine 的窄入口 `./server/runtime` 只读出口，`precheck` 的 `module-registry` 步骤
   随即报出：*「模块 agent-config 的服务端代码导入了已注册模块 machine，但 manifest 未声明
   dependsOn: ["machine"]」*。而这条 `dependsOn` **不可能声明**——`machine/fenix.module.ts` 已声明
   `dependsOn: ["agent-config"]`（它解析 AgentNode），其注释明写「方向固定为它们 → 本模块，写进本模块会
   反转装配方向并成环」。**也就是说宿主 `schema.ts` barrel 长期承担了「资源模块之间唯一不产生包级边的
   取数通道」——正是 §1.7 要拆掉的那根梁。**
   最终形态改为**宿主注入端口**（两个方向的先例都在仓库里：`MachineRegistryPort`、`AgentConfigLookupPort`）：
   - `agent-runtime` 在既有 `MachineRegistryPort` 上加 `findMachineAgentNamesByIds`（该端口的既有契约
     就是「未装配时 fail-fast，禁止 runtime 回链资源包」），宿主在 `host-wiring.ts` 绑定 machine 的实现；
   - `agent-config` 新建窄 `MachineLookupPort`（`src/server/ports/machine-lookup.ts`，与
     `UserAgentPreferencesPort` 同形状），宿主在 `host-startup.ts` 绑定同一族实现；
   - 展示标签回退链（`name` → `machineInfo.hostname` → `agentName`）落在 machine 的
     `findMachineLabelsByIds`——它是 machine 自己的词汇，不是消费方视图的语义；调用方只保留「取不到就退回
     machineId」这一层视图语义。
   窄入口方案已随本批**撤回**（`runtime.ts` 与 `./server/runtime` 出口删除），不留未使用的新抽象。
   **这是剩余 12 批的统一口径**：跨包调用期取数要么经 owner 的公开 service / DTO（无装配环时），要么经宿主
   注入端口（会成环时）；只把 import 改指 owner 的 `./db` 出口**不算完成**。判定依据是
   `bun run generate:module-registry --check`——它会直接指出「导入了已注册模块但未声明 dependsOn」。

5. **owner 包的 `db/schema.ts` 要为每个跨包外键声明被引用表所在包。** §6.1 的 `db/` 例外只让
   `special-dependency` 提前返回，`undeclared-workspace-dependency` 没有豁免。按宿主现有 FK 图，除
   `memory`（只外键 `agent_config`）与 `prod-view`（同）外，其余 10 个 owner 包都要声明 `@fenix/identity`。
   B1 已踩到这条：`agent-runtime` 因跨包读取补了 `@fenix/resource-machine` 声明。
6. **各包的 source-migration 契约测试含「`@server/db/schema` 残留数 > 0」的正向控制**，该包自己的表
   迁完、跨包读取又都改指 owner 出口后，这条断言必然失败。B1 对 machine 的处置是把计数改成精确列表并
   注释说明随批次收缩；后续每批同做。
7. **两处调用期跨包写需在对应批次一并处理**：machine `registry.ts` 以 `agentName` 匹配后 UPDATE
   `agent_config.machineId`（随 B7）；agent-config `agent-config-resource.ts` 删 agent 时 DELETE
   `environment` 行（随 B8）。两处**都不触发门禁**（`resource → resource`、`resource → agent-runtime`
   均不在禁则内），不阻塞迁表；但迁表后会变成「经对方出口写别人的表」，届时应一并收敛为 owner 的写入口。

## 五、分片进度

| 分片 | 内容 | 状态 | Commit |
|---|---|---|---|
| A1 | 日志脱敏与泄露点收敛 | **已撤回**（用户裁定） | `4e03cc72b` → 撤回 `6e0991f3a` |
| A2 | 子进程 env 白名单 | 已交付 | `eef8104be` |
| A3 | `scripts/migrate.ts` fail-closed + advisory lock | 已交付 | `aae9bc44c` |
| A4 | 启动不再隐式跑数据迁移、发布期入口 | 已交付 | `aae9bc44c` |
| A5 | 门禁补齐（scripts 扫描 + owner-inventory 步） | 已交付 | `79c475807` |
| A6 | 架构文档过期路径修正 | 已交付 | `180cd66ac` |
| B0 | 跨包 schema 导入的路径作用域例外 + 零差异门禁 | 已交付 | `b3411344b` |
| B1 | machine / registry_event 迁至 `@fenix/resource-machine/db` | 已交付 | 见 §7.10 |
| B2 | mcp（`mcp_server`、`mcp_tool`）迁至 `@fenix/resource-mcp/db` | 已交付 | 见 §7.11 |
| B3 | model-management（`provider`、`model`、`model_gateway_credential`，含 3 个 pgEnum）迁至 `@fenix/model-management/db` | 已交付 | 见 §7.12 |
| B4 前置 | 沙盒实例投影写路径移到 sandbox 侧（§4.8 第 3 条，已裁定） | 已交付 | 见 §7.13 |
| B4 | sandbox（`sandbox_pool`、`sandbox_instance`）迁至 `@fenix/resource-sandbox/db` | 已交付 | 见 §7.14 |
| B4 审计整改 | 契约测试的夹具判别力与 `db/` 扫描集补正（代码，`d549e0838`）+ 七处取证口径订正 | 已交付 | 见 §7.18 |
| B5 | skill（`skill`）迁至 `@fenix/resource-skill/db` | 已交付 | 见 §7.15 |
| B7 前置 | agent-runtime 的 `agent_config` LEFT JOIN 改为经 owner 公开入口取投影，装配方向不允许时退回宿主注入端口（§4.8 第 4 条 / §8.4 第 7 条） | 待办·须先反馈 | — |
| B7 前置 | join 表归属与 D4 的冲突复核（§8.4 第 8 条） | 待办·须先反馈 | — |
| B6 | workflow（九张领域表）迁至 `@fenix/resource-workflow/db` | 已交付 | 见 §7.17 |
| B7–B13 | 其余 17 张表按拓扑序迁出（§4.7 表共 36 张，B1–B6 已迁 19 张；§4.7.1 交付面） | 待办 | — |
| C0 | 打通模块声明的 env 回流至宿主 | 已交付 | `cb0c5976c` |
| C1 | `workspace-resolver` 改读模块配置 + `WORKSPACE_ROOT` 收敛 | 待办 | — |
| C2–C18 | 其余模块声明 `envDefinitions` | 待办 | — |
| 门禁 | precheck 步骤基线补正与 `db/` globs 覆盖 | 已交付 | `cb738e6c2` |

## 六、与计划的偏差

1. **1.7 第②条的数据迁移 runner 落点**：任务书写 `db/data-migration-runner.ts`（仓库根
   `db/`），与本仓既有「脚本归 `scripts/`」惯例不同；本批按任务书原文落点，不擅自改。
2. **`ENV` 声明的 `secret` / `restartRequired`** 目前无任何消费者；补声明批次需明确这两个
   字段是「实现消费者」还是「保留并登记」，见 §八。
3. **宿主 env schema 缺 2 键**（`GOTENBERG_URL`、`RCS_WORKFLOW_HMAC_SECRET`）：这两键由模块
   声明、宿主未登记，补登记属 C 块范围（§八）。

## 七、交付记录

### 7.1 A1 整批撤回（2026-09-21，`6e0991f3a`）

按用户裁定「日志脱敏不用做」，整批撤回 `4e03cc72b`：

- 移除 `@fenix/logger` 新增的 `SENSITIVE_KEYS` / `scrubSensitive` / `maskConnectionCredentials`
  及 `logger-scrub-sensitive.test.ts`（176 行）；
- 13 处日志调用恢复为改动前形态：prompt 正文与 Agent 响应**仍按原样截断后打印**；
- 该撤回同时消除 `apps/web` 之外的连带缺陷：`packages/resources/workflow/web/pages/workflow/
  WorkflowEditor.tsx:530` 在删掉 `console.log` 后 `meta.params` 成为 `useCallback` 的多余依赖，
  触发 `lint/correctness/useExhaustiveDependencies`，使 `bun run lint` 在 `4e03cc72b` 退出 1。
  撤回后全量 lint 复核通过（`Checked 2301 files, No fixes applied`）。

撤回前的设计认知（撤回后仍成立，写入本记录以免后人重复踩）：

- `argsToMsg` 会把对象 `JSON.stringify` 进**消息字符串**，而 pino 的 `redact` 只作用于合并对象，
  因此 **pino `redact` 对本仓的日志正文无效**；
- 调用方自己拼好的字符串（如 `text: prompt.slice(0, 200)`）按键名脱敏也拦不住；
- 环引用与深度上限在**安全控制**里必须 fail-closed（超深度原样返回会让深层敏感键明文落盘）。

### 7.2 A5 门禁补齐（2026-09-21，`79c475807`）

- 根 `lint` / `lint:fix` / `format` / `format:check` 的路径里删掉**不存在**的
  `apps/web/components/`——biome 对不存在路径只打 `INTERNAL` 却退出 0，等于门禁静默降级；
  同时补上此前漏扫的 `scripts/`。
- `scripts/ci.ts` 新增 `owner-inventory` 步骤（13 → 14 步）：该清单是「文档 == 规则表产出」
  的生成物，不补则 CI 严于 precheck（§4.4）。
- `.github/workflows/ci.yml` 同步新增 `generate:web-contributions --check` 与
  `check:root-owner-inventory` 两步，注释「三项检查」改为「四项」。

### 7.3 A6 架构文档过期路径修正（2026-09-21，`180cd66ac`）

物理迁移后 11 篇文档的 56 处引用仍指向根目录 `src/`、`web/` 旧路径，逐处改为迁移后真实路径
（新路径均以 `git ls-files` 核实存在）：`docs/arch/05-chat.md` 6 处、`19`/`20`/`21` 三篇 14 处、
`tech-stack-frontend.md` 4 处、`docs/developer/arch/` 四篇 28 处、`frontend-development.md` 3 处。
`root-source-owner-inventory.md` 按 §4.5 由生成器模板产出后重新生成。

**未随本批处理的 A6 待确认项**（属内容级重写、无 1:1 后继，登记见 §八）：`docs/arch/12-files.md:545`
附录 A 与同段「代码仍挂载」表述、`docs/developer/arch/execution-engine-architecture.md:58,60`、
`hindsight-memory-architecture.md:86,111,144`、`remote-machine-registry.md`（7 处带行号锚点）、
`docs/developer/guide/backend-development.md:19` §1.1 整段与 `:308` 的已删包示例。

### 7.4 CLAUDE.md 过期路径修正（2026-09-21，`95d1dcf4b`）

按 §4.6，前端地图与前端边界两节的 `apps/web/src/api/` 改为 `packages/web-runtime/web/api/`
与出口名 `@fenix/web-runtime/api/request`。

### 7.5 A2 子进程环境收敛为白名单（2026-09-21，`eef8104be`）

宿主曾把整个 `process.env` 作为**打底**透传给 Agent 与 Workflow 节点子进程，泄漏
`DATABASE_URL`、`RCS_API_KEYS`、`RCS_SYSTEM_API_KEYS`、`LANGFUSE_SECRET_KEY`；`python-executor`
的 `pip install` 会执行任意第三方包代码，等于「任意代码执行 + 密钥窃取」（§10.6.3）。

- 新增两个白名单模块，各自注明逐键理由与「为什么更短」：`packages/acp-link/src/spawn-env.ts`
  （Agent：`PATH`/`HOME`/`USER`/`LOGNAME`/`SHELL`/`PWD`/`TMPDIR`/`TMP`/`TEMP`/`TERM`/`TZ`/`LANG`
  + `LC_` 前缀）与 `packages/workflow-engine/src/executor/node-env.ts`（节点更短，用户代码不需要
  Agent CLI 依赖的交互变量）。两者都只替换**打底**，合并方向仍是 `{ ...白名单, ...launchSpecEnv }`。
- 5 处调用点：`acp-link` 的 `server.ts:1097` / `client/acp-spawn-helper.ts:50` /
  `client/session-manager.ts:108`、`plugin-claude-code` 的 `claude-code-runtime.ts:72`、
  `workflow-engine` 的 shell 节点与 python 节点（含 `pip install`）两个执行器。
- **回退补偿**：`claude-acp-adapter.ts:60,224,407` 在 acp-link 进程内直读 `ANTHROPIC_MODEL` 与
  `CLAUDE_CODE_CLI_PATH`，原先靠继承到达。按「配置由调用点显式下发、白名单保持最小」在
  `claude-code-runtime.ts` 的 spawn 点逐键补齐（`pickDefinedHostEnv`），**未**把这些键加入白名单
  ——按 `ANTHROPIC_*` 前缀放宽会让宿主密钥随下一次改名重新泄漏。
- 静态门禁：`scripts/check-dependency-boundaries.ts` 增加独立源码扫描（不进台账归一流程），
  正则按 §4.3 修正后零误伤。**范围故意只含 `packages/**/src/**`**：本次收窄前实测 `apps/**`
  零命中，该步骤因此不是全仓门禁，覆盖的是包内 spawn 点。

已知行为变化（**用户可见**）：工作流节点不再继承宿主环境变量，改用节点 `env` / `secrets`
字段显式声明；这是 §10.6.3 的既定方向，补偿通道即节点字段，见 §八。

### 7.6 A3 / A4 迁移入口与发布期数据迁移（2026-09-21，`aae9bc44c`）

**A3 `scripts/migrate.ts` fail-closed**：原脚本把「异常 message 含 `already exists`」当作「库是
`db:push` 建的」并以退出码 0 结束，于是任何 message 恰好含该子串的真实失败（典型是部分执行后
遗留不一致状态下的 `CREATE INDEX ... already exists`）都会被伪装成成功。该容忍的真实诱因是
**多副本并发 DDL**（`docker-compose.yml` 让每个应用容器启动前各跑一次 `migrate.js`），诱因由
会话级 `pg_advisory_lock`（常量 key，独立 `Client` 持锁、`Pool({max:1})` 供 `migrate()`）消除，
不再需要吞错兜底。同时删除源码里的默认连接串回退，并加 `import.meta.main` 守卫。

**A4 数据迁移改由部署期执行**：`§6.3` / `§10.6.2` 要求一次性数据迁移只由发布任务执行。
`host-startup.ts` 移除 `runDataMigrations()`；新增 `db/data-migration-runner.ts`（任务书既定落点）
作为发布期入口，只做汇总、按序执行、日志、fail-stop 与退出码，`verify` / `compensation` / 指标 /
claim 状态机**不在其中搭建**（登记为未完成，见 §八）。入口按宿主口径初始化应用基础设施
（`loadServerEnv` → `applyEnv` → `initializeApplicationInfrastructure`），否则迁移读模块配置会抛
「应用基础设施尚未初始化」；`Dockerfile` 增加 `data-migrate` 阶段，产物同时拷入运行时镜像。

**运维影响（必须随发布流程落地）**：新增强制步骤，固定顺序为 DDL（`migrate.js`）→ 数据迁移
（`bun data-migration-runner.js`）→ 应用进程。跳过第二步不会报错，只是永不应用待办数据迁移。
该步骤必须与应用**同一份环境变量**（含 `DATABASE_URL`、`RCS_API_KEYS`）与**同一数据卷**
（写入 `skillDir`，卷不一致会留下「记录已落库、应用读不到迁移后文件」且重跑因记录存在而跳过、
无法自愈），且**不得写进 compose 的容器启动命令**（数据迁移含文件副作用，多副本并发不是幂等）。

### 7.7 precheck 步骤基线补正与 `db/` 门禁覆盖（2026-09-21，`cb738e6c2`）

A5 把 `owner-inventory` 补入 `scripts/ci.ts` 后，`apps/server/src/__tests__/architecture-check.test.ts`
的期望步骤列表没有同步，precheck 直接变红——**门禁自身的测试也是门禁的一部分**。同批补上 A5 遗留的
目录覆盖：`ci.ts` 的 `format` / `import-sort` / `lint` 三条 biome 命令、根 `tsconfig.json` 的 include
此前都不含新增的 `db/`，新目录会落在检查之外。交付面：测试期望列表 + 三处 globs + include。

### 7.8 C 批 0：打通模块声明的 env 回流至宿主（2026-09-21，`cb0c5976c`）

`resolveAssemblyEnv()`（新建 `apps/server/src/bootstrap/assembly-env.ts`）把「读 profile → 解析模块
清单 → 汇总 `envDefinitions` → 交宿主 `loadServerEnv` 校验」串成一条通路，`main.ts` 改走它。这是
C 块其余批次的前置：不打通这条通路，给 17 个模块补 `envDefinitions` 对宿主接线**零效果**（§4.2）。

同批收紧一处边界：`env-loader` 新增 `assertNoHostKeyOverride()`，同一变量同时由宿主 env schema 与
模块声明提供时**启动期失败**，而非静默取舍——依据 §10.1 第 1 条「同一变量只能有一个声明处」。
17 个模块当前 `envDefinitions` 全为空，故本批**零行为变化**，由 4 条回归用例锁定
（`apps/server/src/__tests__/assembly-env.test.ts`：模块声明回流、无声明时逐键等价、profile 一致、
宿主同名冲突启动失败）。已知破测属 C1 范围，登记于 §8.4。

### 7.9 B 块前置：路径作用域例外与零差异门禁（2026-09-21，`b3411344b`）

三件事同批，缺一件 B 块就无法开工：

1. **路径作用域例外落地**（§4.1 的用户裁定）：`scripts/lib/architecture-boundary-rules.ts` 新增
   `isSchemaAssemblyPath()`，`special-dependency` 规则对 `packages/**/db/**` 直接返回空；
   `.dependency-cruiser.cjs` 的 `agent-runtime-not-to-resources` 加 `pathNot` 排除其 `db/`。
2. **权威设计同步四处**：`ce-ee-engineering-standards.md` §2.2（调用期禁则不含组装期引用）、
   §2.3（矩阵两行加注）、§6.1（新增「跨模块外键的 schema 组装期例外」段与三条边界）、
   §10.2 第 2 条（登记该例外）；`packages/platform/identity/fenix.module.ts` 的口径同步订正。
3. **零差异门禁**：新建 `scripts/check-schema-ddl-drift.ts`（`generateDrizzleJson` + `generateMigration`
   比对 schema 聚合结果与最新 snapshot），`ci.ts` 从 14 步变 15 步。**自测含一条反向用例**
   （空 schema 必须报出大量 `DROP TABLE`）——`generateMigration` 返回 `Promise<string[]>`，漏 `await`
   会得到 0 条**假绿**，反向用例是这条门禁唯一能自证不失效的手段。

### 7.10 B1：`machine` / `registry_event` 迁至 `@fenix/resource-machine/db`（2026-09-21，本批）

**交付面**：新 owner 文件 `packages/resources/machine/db/schema.ts`；`package.json` 加 `./db` 出口；
包内 6 个读取点改指本包出口；宿主 `schema.ts` 删两张表定义、改为 import 该出口供
`agent_config.machine_id` 表达外键；`drizzle.config.ts` 加 schema 路径；**调用期跨包读取点收口**（见下）；
`agent-runtime` 补 `@fenix/resource-machine` 依赖声明；10 个包的静态契约测试把 `db` 纳入扫描入口
（B1 起各包的 `db/` 才有内容，同批开门禁以免新目录落在检查外）；README / `db.ts` / 注释与
`docs/developer/arch/remote-machine-registry.md` 的表定义锚点同步。

**调用期跨包取数收口**（关键交付面，原设计遗漏；经两轮裁定定型）。两处 `src/**` 调用期读取曾
在第一轮改为 `@fenix/resource-machine/db`，但 §6.1 边界 1 明确「`src/**`、`web/**` 里出现跨包 schema
导入仍按 §2.2 / §2.3 判定为违规」，例外只在各包 `db/` 内成立——改指 owner 出口并不解决它。第二轮按用户
裁定改为调用 machine 的公开函数，第一版形态是 machine 新设窄入口 `./server/runtime`，被门禁挡下：
`precheck` 的 `module-registry` 步骤报 *「模块 agent-config 的服务端代码导入了已注册模块 machine，但
manifest 未声明 dependsOn: [\"machine\"]」*，而这条 `dependsOn` **不可能声明**——`machine` 的
`dependsOn` 已含 `agent-config`（`remote-file-service.ts` 解析 AgentNode），反向声明会闭合二元环，所有
profile 的装配顺序校验都会失败。**宿主 `schema.ts` barrel 之所以长期存在，正是因为它是资源模块之间唯一
不产生包级边的取数通道**——这正是 §1.7 要拆掉的梁，所以不能靠"再开一个入口"解决。

第三轮（最终形态）改为**宿主注入端口**，两个方向都复用仓库既有先例
（`MachineRegistryPort` / `AgentConfigLookupPort`）：

- `agent-runtime`：在既有 `MachineRegistryPort` 上加 `findMachineAgentNamesByIds`。该端口的既有契约就是
  「未装配时 fail-fast，禁止 runtime 回链资源包」，新增一个只读投影方法与生命周期方法同一个理由；
  宿主在 `apps/server/src/bootstrap/host-wiring.ts` 绑定 machine 的实现
  （`findMachineAgentNamesByIds`）。
- `agent-config`：新建窄端口 `src/server/ports/machine-lookup.ts`（`MachineLookupPort` +
  `bindMachineLookupPort` / `getMachineLookupPort` / `resetMachineLookupPort`，与既有的
  `UserAgentPreferencesPort` 同形状），由 `packages/resources/agent-config/src/server.ts` 导出；
  宿主在 `apps/server/src/bootstrap/host-startup.ts` 绑定（与本文件已有的另两个 agent-config 端口放在
  一起——`host-wiring.ts` 刻意不导入 agent-config 入口）。
- 消费点三处全部改为取投影：`agent-runtime/services/environment-web.ts` 两处改用
  `getMachineRegistryPort().findMachineAgentNamesByIds([...])`；`agent-config/services/
  agent-related-resources.ts` 一处改用 `getMachineLookupPort().findMachineLabelsByIds([...])`。
- 展示标签回退链（`name` → `machineInfo.hostname` → `agentName`）**落在 machine 的
  `findMachineLabelsByIds`**：「一台机器怎么显示」是 machine 自己的词汇。与既有
  `findMachineNamesByIds`（`name ?? agentName`，Observer 面板用）**不合并**——中间那一环不同，合并会改变
  其中一方的展示结果，故两个函数各自注释了差异。调用方只保留「取不到就退回 machineId」这层视图语义。
- 行缺失时端口内**不造值**，返回的 Map 里没有该 id，由调用方决定退回 id 还是置空。
- 测试桩 `apps/server/src/test-utils/setup-mocks.ts` 同步绑定两个端口，且**绑真实实现**——端口读的 DB
  就是该文件已替换的替身（`getMachineDatabase()` 与 `getAgentConfigDatabase()` 同源于 platform-sdk 的
  `getDatabase()`），因此行为与迁移前「调用方自己 select」逐字一致，没有需要替身化的进程状态。
- 第一版的 `runtime.ts` 与 `./server/runtime` 出口随本批**删除**，不留未使用的新抽象。

口径与边界见 §4.8 第 4 条（这是剩余 12 批的统一口径）。

**对抗式审计与整改**（工作流 `wf_da9b4eee-614`，4 个视角 × 双人反驳）：finders 共报 16 条，本轮整改
4 条实质问题——`skill-source-boundary.test.ts` 是 10 个同族扫描器里唯一漏加 `db` 的；`machine.type`
列断言被删后全仓无覆盖（已在 owner 包接回）；台账 rationale 谎称 sandbox 侧「已改指该出口」（实为
删除用例）；两处已过期的结论性注释与 machine README 两条失效强断言。审计提出的门禁与批次风险已登记
在 §4.7.1 / §8.4。

**为什么台账条目**没删：见 §4.8 第 2 条。`scripts/architecture/exceptions.json` 只更新了 machine 条目的
rationale，记录「本包自己的表已迁出、残留 3 处跨模块读取」这一中间态。

**验证**：`check:schema-ddl-drift` 零差异；`architecture:check` 通过（2122 files，19 条已登记例外）；
`check:dependencies` 通过（2264 modules，10 条已登记例外，0 条新增违规——端口没有引入新的包级边）；
module-registry 步骤通过（17 个模块 manifest 全部对齐）；
`tsc --noEmit` 无错误；machine 547、agent-config 711、agent-runtime 488 包内全绿，
sandbox / mcp 289 / workflow 726 / task 321 / channel 202 / prod-view 116 / observer 83 各自单跑全绿。

**非确定性失败记录**（CLAUDE.md 要求：需要重复时记录原因与证据）。本批在 `bun test packages/` 上
观测到三次**互相矛盾**的结果，而代码状态完全相同：`7794/2/3 fail`、`7899/2/57 fail`、`7954/2/2 fail`。
特征与归因：

- 失败集中在 happy-dom 组件测试与含定时器的用例，耗时分布异常（同一用例在 1ms 与 9.5s 之间摆动）；
  全量耗时 74s → 102s → 164s。
- **逐文件单跑全部通过**：抽查 `agent-resource-picker-interaction`（9 pass）、`python-executor` +
  `channel-list-error-feedback` + `workflow-list-load-state`（24 pass）、`fs-download-zip`（3 pass）。
- 同期 `uptime` 的 1 分钟负载达 **5.38**（10 核）；负载回落到 1.34 后同批不再复现。
- 归因：`bun test packages/` 默认 10 个 worker × 单 worker 并发 20，与其它进程争抢 CPU 使时序敏感的
  前端用例超时/断言失败。**与本批改动无因果关系**（失败集合里没有 machine 相关文件，且两次全量失败
  的文件集合互不相同）。

**状态**：已在低负载下重跑取得一次**干净的全绿结果**并提交（`eb4b8cdc6`）：15 步全通过，其中
package-tests 7956 pass / 2 skip / 0 fail、server-and-script-tests 806 pass、web-app-tests 319 pass，
总耗时 126.6 秒。上文的非确定性失败因此确认为**负载导致**，非本批缺陷。

### 7.11 B2：`mcp_server` / `mcp_tool` 迁至 `@fenix/resource-mcp/db`（2026-09-21，本批）

**交付面**：新 owner 文件 `packages/resources/mcp/db/schema.ts`（`mcpTool` 与 `mcpServer` 两张表定义与
宿主被删段逐字一致，含索引名 `idx_mcp_tool_org_server` / `idx_mcp_server_org_name` /
`idx_mcp_server_org_visibility`）；`package.json` 加 `./db` 出口，并按 §4.7.1 ② 补
`@fenix/identity` 声明（`mcpServer.userId → user.id`，与 B1 的 machine 同因）；包内 4 个读取点改指本包
出口（`src/server/repositories/mcp-server.ts`、`src/server/services/mcp-server-service.ts`、
`src/server/access/mcp-server-resource.ts`、`src/__tests__/mcp-server-repository.test.ts`）；宿主
`schema.ts` 删两张表定义、改为 import 该出口供 `agent_config_mcp.mcp_server_id` 表达外键；
`drizzle.config.ts` 加 schema 路径；**调用期跨包读取点收口**（见下）；`README.md` 四处、`src/server/db.ts`、
`fenix.module.ts` 与 `mcp-source-migration.test.ts` 的注释同步。

**调用期跨包取数收口（与 B1 走了不同路径，原因是装配方向不同）。** B1 的两处必须走宿主注入端口，因为
`machine` 的 `dependsOn` 已含消费方、反向声明会闭合装配环。B2 的消费点在 `agent-config`，而
**`agent-config/fenix.module.ts` 已声明 `dependsOn: ["knowledge", "mcp", "memory", "skill"]`**——
`agent-config → mcp` 是既有声明的合法方向，**无需端口，直接 import owner 的窄出口即可**：

- mcp 新增调用期投影 `findMcpServerLabelsByIds`（`src/server/repositories/mcp-server.ts` 末尾）：按 id
  批量取**展示标签**（`mcp_server.name`），空入参返回空 Map、缺失的 id 不出现在结果里；只读、无授权判断，
  与邻居 `listByIdsUnscoped` 同一授权前提，差别只在形状与列宽（后者返回整行，含 launch spec 要读的
  `config` jsonb）。「一台 MCP 服务怎么显示」是 mcp 自己的词汇，不是消费方视图语义。
- 出口选 `./server/config`（`src/server/services/config/agent-config-mcp.ts`）而**不是**服务端 barrel：
  该文件头自述「barrel 会连带把 HTTP 路由与 agent-runtime 拉进消费方的依赖图」。`agent-config/src/
  server/services/agent-related-resources.ts` 的导入改为 `@fenix/resource-mcp/server/config`，读取点由
  `db.select(...).from(mcpServer)` 改成 `findMcpServerLabelsByIds(input.mcpIds)`（与 skill 的标签查询并列在
  同一个 `Promise.all` 里）。该文件的文件头段落同步改写成「machine 走端口、mcp 走已声明 `dependsOn` 的公开
  入口，差别不是风格而是本包能否直接导入对方」。
- 合法性由 `bun run generate:module-registry --check` 判定（17 个模块 manifest 通过），即没有引入新的
  包级边；`check:dependencies` 的 0 条新增违规是同一结论的第二个证据。
- **B3 不能照抄这条。** `agent-config` 的 `dependsOn` 不含 `model-management`，而 model / provider 的标签
  读取就在同一个文件里（§4.8 第 1 条的读点清单），照 B2 直连做法会命中 `dependsOn` 缺失；B3 开工前须先按
  §4.8 第 4 条口径定夺（公开入口 vs 宿主注入端口）。**（B3 已定夺：走宿主注入端口 `ModelLookupPort`，
  理由是 `model-management` 的 `dependsOn` 已含 `agent-config`、反向声明会闭合二元环；见 §7.12。）**

**宿主侧调用期的处置（用户裁定，2026-09-21）：登记为 carve-out，不在 §4.7.1 ① 的收口范围内。** 本批把
`apps/server/src/services/data-migrates/backfill-resource-visibility.ts` 的 `mcpServer` 导入从
`../../db/schema` 改指 `@fenix/resource-mcp/db`。该文件是**宿主部署期**数据迁移（release 步骤执行一次，
位于 DDL 之后、新版本进程启动之前，见 §6.3 / §10.6.2），调用期读写四张受控资源主表
（`agent_config` / `skill` / `mcp_server` / `provider`）的 `visibility` 列。判定不适用本条的理由：
§4.7.1 ① 的依据是 §2.2 / §2.3 的**包级依赖矩阵**（§6.1 边界 1 的路径作用域为 `packages/**/db/**`），
是 packages 域禁则；宿主是唯一同时持有全部 owner 表定义的装配层（这正是宿主 `schema.ts` 经 owner `./db`
表达外键的同一条理由，B1 已如此），而该迁移是一次性的、随下一次发布 `DROP TABLE resource_permission`
一并删除——为一个寿命只剩一次发布的迁移新建 4 个 owner 写 API，违反 CLAUDE.md「抽象延迟到第二个真实
用例出现时才引入」。口径已写入 §4.7.1 第 1 条，供 B3–B13 直接引用。

**为什么台账条目没删**：见 §4.8 第 2 条。B2 后 mcp 包的 `@server/db/schema` 残留**精确为 1 处**——
`src/server/services/config/agent-config-mcp.ts` 读宿主自己的 `agent_config_mcp`（该表归 B7）。
`scripts/architecture/exceptions.json` 的 mcp 条目只更新了 `rationale` 与 `removeWhen`（把原先的「5 处」
订正为「1 处」，并把成因指向 `agent_config_mcp`），**条目必须保留到 agent-config 批落地**。

**契约测试正向控制的收缩**（§4.7.1 ③）：`packages/resources/mcp/src/__tests__/mcp-source-migration.test.ts`
的 `ALLOWED_HOST_IMPORT` 注释改成「本包自己的表已迁出，这条残留现在只剩 `agent_config_mcp` 一处」，
并注明该表迁出后正向控制会失效、须改为反向断言。

**对抗式审计与整改**（工作流 `wf_245c2c44-797`，4 个视角 × 逐条反驳验证）：finders 共报 20 条，
verifier **确认 10 条 / 驳回 10 条**（确认项含 2 条纯核验记录）。

- 采纳并已整改 1 条：`backfill-resource-visibility.ts` 的 `@fenix/resource-mcp/db` import 位置破坏 biome
  `organizeImports`，**本批在磁盘上带着全仓唯一一条 lint 错误**。该项在审计进行中已修（移到
  `@fenix/logger` 之后），现全仓只读 `biome check` 为 `Checked 2309 files / No fixes applied / EXIT=0`。
  附带结论值得留档：`precheck` 的 import-sort 步骤带 `--write`，会把这类违规**静默改写**掉，因此
  「`precheck` 全绿」不等于提交内容已过只读 lint（与「precheck 读磁盘而非 git 索引」同类风险）；
  CI 的 `bun run lint` 无 `--write`，会直接红在这个文件上。
- 采纳并已整改 1 条：本节原先缺失——§五 表的 B2 行指针悬空，本批的交付面四条结论、残留 5→1 的实测、
  各门禁实测值均无权威落点。已补本节，§8.4 第 4 行的批次余量同步订正。
- **驳回 10 条**。其中 4 条是同一主张的重复（「宿主 data-migrate 经 owner `./db` 读写属 §4.7.1 ① 禁止的
  形态」），四条 verifier 独立判「不成立」，理由与上面的 carve-out 裁定一致（错把 packages 域禁则套到宿主
  层），故不改代码、只登记。其余驳回项：README 两条依赖边界断言「已失效」（该 bullet 最后改于
  `b5c5323f` 的 1.6 T7、非本批改动，且 `db/` 例外是 §6.1 的组装期规定）；`./server/config` 出口被扩成
  「关联表访问 + 主表标签投影」两件事「与 skill 同形出口不一致」（那正是该出口文件头的自述，属已登记
  口径）；包内测试导入 owner `./db` 取表对象（B1 对 machine 用例已有同类写法并落地）；CLAUDE.md 与
  `backend-development.md` 的「schema 真相来源有两个」过期（属 1.8 文档全量更新，§6.1 已登记）。
- **读取点余项清单的落点缺口**（审计发现，如实登记）：§4.8 第 1 条的「B1 实测 19 处」是 B 块全部跨包
  调用期表读取点总数，本批收口其中 1 处（`agent-config` 的 mcp 标签读取），余 18 处随 B3–B13 逐批收口。
  **逐包清单没有权威落点**——§4.8 #1 与 §8.4 #4 原先的「见 §7.10」所指清单在 §7.10 中并不存在。完整清单
  的逐包盘点需要「逐包核对不再引用 `@server/**`」这一次扫描，与 §8.4 第 3 条的 14 条台账清零同源，故并入
  B 块末期一起做（§8.4 第 4 条已同步登记）。

**验证**：`check:schema-ddl-drift` 零差异（迁表未产生任何 DDL 漂移，证明两张表定义逐字等价）；
`check:dependencies` 通过（2265 modules，0 条新增违规——`./server/config` 出口没有引入新的包级边）；
`architecture:check` 通过（2123 files，19 条已登记例外）；`bun run generate:module-registry --check` 通过
（17 个模块 manifest 全部对齐，即 `agent-config → mcp` 的方向合法）；`tsc --noEmit` 无错误；
`bun test packages/resources/mcp packages/resources/agent-config` **1000 pass / 0 fail**（69 files）；
`bun test apps/server/src/__tests__` **639 pass / 0 fail**（46 files）。

**非确定性失败记录**（CLAUDE.md 要求：需要重复时记录原因与证据）。本批首次全量 `precheck` 在
`server-and-script-tests` 步骤红过一次：`apps/server/src/__tests__/round37-service-boundaries.test.ts:184`
的 `expect(fixture.calls).toEqual({ restart: 1, recover: 0, markError: 0 })` 实得 `recover: 1`。归因与证据：

- **与本批改动无因果关系**：该文件只涉及 `SandboxExecutionHandler` 与 sandbox manager 桩，全文不出现
  `mcp` / `agent-config` / `@server/db/schema`；用例自身以 `runtimeConnectTimeoutMs: 1`（1 ms 连接超时）
  驱动「首次等待失败 → 重启」这条路径，`recover: 1` 说明在 CPU 争抢下走了另一条分支——**用例定义上就是
  时序敏感的**。
- **单跑与复跑均通过**：单文件单跑 130 pass / 0 fail；同一命令（三个目录）复跑 806 pass / 0 fail；
  完整 `precheck` 复跑 15/15 全绿。
- 与 §7.10 记录的 `bun test packages/` 非确定性属同一类（负载下的时序敏感用例），非本批缺陷。

**状态**：复跑取得一次**干净的全绿结果**并提交：15 步全通过，其中 package-tests 7956 pass / 2 skip /
0 fail、server-and-script-tests 806 pass、web-app-tests 319 pass，总耗时 86.3 秒。

### 7.12 B3：`provider` / `model` / `model_gateway_credential` 迁至 `@fenix/model-management/db`（2026-09-21，本批）

**交付面**：新 owner 文件 `packages/resources/model-management/db/schema.ts`——三张表定义与宿主被删段
逐字一致（含 `idx_provider_org_name` / `idx_provider_org_visibility` / `idx_model_provider_model` /
`idx_model_org_provider_model` / `idx_model_gateway_credential_{subject,external_id,status_id}` 七个索引名），
**`providerProtocolEnum` / `providerKindEnum` / `modelGatewayCredentialStatusEnum` 三个 pgEnum 随表迁入**
（`packages/**` 此前 pgEnum 计数为 0，这是 owner 包持有枚举的首例；`check:schema-ddl-drift` 零差异证明
迁移链未感知这次搬家）；`package.json` 加 `"./db"` 出口，并按 §4.7.1 ② 补 `@fenix/identity` 声明
（`provider.userId → user.id` 是迁出后唯一的跨包外键）；包内 5 处导入改指本包出口
（`server/access/provider-resource.ts:1`、`server/repositories/{provider-resource,model-resource,
model-gateway-credential}.ts`、`__tests__/model-gateway-schema.test.ts:2`）；宿主 `schema.ts` 删三张表与
三个 pgEnum、改为 import `@fenix/model-management/db` 供 `agent_config.model_id` 表达外键；
`drizzle.config.ts` 加 schema 路径；**调用期跨包读取点收口**与宿主 data-migrate 处置见下；`README.md`
第 3 行与「边界残留」第 1–2 条、`src/server/db.ts`、`src/server/config-envelope.ts` 的注释同步；
`docs/developer/arch/litellm-integration.md` 两处以 `providerProtocolEnum` 为锚点的过期位置引用（`:579`
的「schema.ts 第 17 行附近」与 `:810` 写死的 `src/db/schema.ts:17`）随批改指 owner 路径。

**调用期跨包取数收口：本批**必须**走宿主注入端口——B 块第一个「不能直连」的样本。** B2 的直连依据是
`agent-config/fenix.module.ts` 已声明 `dependsOn: ["mcp", ...]`；B3 的同一条路走不通，因为
**`model-management` 的 `dependsOn` 已含 `agent-config`**（本批唯一读点在
`agent-config/src/server/services/agent-related-resources.ts` 的 `resolveModelLabel`），反向再声明
`model-management` 会闭合装配二元环。结论按 §4.8 第 4 条落成端口：

- `agent-config` 新增 `src/server/ports/model-lookup.ts`（形状逐条照抄既有 `machine-lookup.ts`：
  `ModelLookupPort` 接口 + `bind` / `get` / `reset` 三件套，重复绑定与未绑定均 fail-fast 抛错），替代原先
  直接 `db.select(...).from(model)` 的读取。
- 实现在 owner 侧：`model-management/src/server/repositories/model-resource.ts` 末尾新增只读投影
  `findModelLabelsByIds(ids)`——按 id 批量取「`provider.displayName ?? provider.name` / `model.displayName
  ?? model.modelId`」标签；只读、无授权判断（与同文件 `findRowUnscoped` 同一前提）、空入参返回空 Map、
  **任何一段取不到都不在 Map 里造值**（含模型行在而 Provider 行缺失），并以
  `provider.organization_id === model.organization_id` 复刻原查询的父子匹配条件。
- 出口走 `./server` barrel 而非窄子路径：唯一消费者是宿主（`host-startup.ts` 与测试 preload），与
  `bindMachineLookupPort`（`@fenix/resource-machine/server` barrel）取用方式一致。
- 绑定点在 `apps/server/src/bootstrap/host-startup.ts`（`wirePermissions` 之后，与另两个 agent-config 端口
  并排），测试侧在 `apps/server/src/test-utils/setup-mocks.ts` 的 preload 里绑**真实实现**——该文件已把
  宿主 db 换成替身，`getModelManagementDatabase()` 与 `getDatabase()` 同源；漏绑不会 fail-fast 到「端口
  未绑定」，只会让模型标签静默退化成 id，因此与 machine 的绑定放在一起并留了注释。
- 两侧各有一份「B3 不能照抄 B2」的注释互相指认（`agent-related-resources.ts` 文件头段落、
  `model-management/src/server.ts` 具名导出处），B4 及以后按同法先判方向再选直连或端口。
- 合法性证据：`bun run generate:module-registry --check` 通过（17 个模块 manifest 对齐，即没有引入新的
  包级边）；`check:dependencies` 2267 modules、0 条新增违规。

**宿主侧调用期的处置（沿用用户裁定，2026-09-21 的 carve-out，见 §4.7.1 第 1 条）**：本批把
`apps/server/src/services/data-migrates/migrate-agent-config-model-id.ts` 与
`backfill-resource-visibility.ts` 的 `model` / `provider` 导入从 `../../db/schema` 改指
`@fenix/model-management/db`。两文件都是**宿主部署期**数据迁移（release 步骤执行一次），
`migrate-agent-config-model-id` 按模型引用定位 `provider` / `model` 行、`backfill-resource-visibility`
按 `provider.visibility` 回填公开受众。理由与 B2 逐条相同（packages 域禁则不适用于装配层宿主 + 迁移
寿命只到下一次发布），不再重复。

**§4.7.1 ③ 在本批不适用（本批暴露的缺口，已登记 §8.1）**：`model-management` 没有 source-migration
契约测试——machine / mcp / sandbox / agent-config / workflow / task 六个包都有，本包只有
`src/__tests__/model-gateway-schema.test.ts`（schema 形状断言，不断言宿主导入残留）。因此本批没有
「残留数 > 0」的正向控制需要收缩；本包与宿主的边界此刻由 `apps-boundary` 台账 +
`check:dependencies` 承担——两者的分工见 §7.18 末条（`apps-boundary` / `undeclared-workspace-dependency`
由 **`architecture:check`** 拦，`check:dependencies` 管的是包级依赖边，2026-09-22 审计订正）。

**为什么台账条目没删**：B3 后本包的 `@server/db/schema` 残留**精确为 1 处**——
`src/server/repositories/subject-agent-search.ts:2` 读的是**宿主自己的** `agent_config`（表归 B7）。
实测 `command grep -rnE 'from "@server/' packages/resources/model-management/src | grep -vE ':[0-9]+: *\*'`
→ **1 行**。`scripts/architecture/exceptions.json` 的 model-management 条目只更新 `rationale` 与
`removeWhen`（成因由「6 处表定义」改指 `agent_config`，归 agent-config 批），**条目必须保留到
agent-config 批落地**：台账是「包对」粒度，提前删除会把尚未迁出的读取一并放行。

**验证**：`check:schema-ddl-drift` 零差异（含三个 pgEnum 搬家，证明 DDL 逐字等价）；`tsc --noEmit` 无错误
（根与 `apps/web` 两张表）；`generate:module-registry --check` 17 模块对齐；`architecture:check` 2125 files
/ 19 条例外；`check:dependencies` 2267 modules、0 条新增违规（+2 modules / +1 依赖声明为预期增量）；
`bun test packages/resources/model-management packages/resources/agent-config` **939 pass / 0 fail**
（80 files）；定向 `round45-agent-config-routes-coverage` + model-management **231 pass / 0 fail**；
`bun test apps/server/src/__tests__/` **639 pass / 0 fail**。round45 的模型标签断言由真实端口实现
（preload 绑定）驱动，替身数据仍是按表身份分发的 `model` / `provider` 行。

**补测（2026-09-22，审计发现）**：审计对 B3 新增的 `findModelLabelsByIds` 做变异实验时发现，删掉逐行组织
一致性条件（`providerRow.organizationId !== row.organizationId` 整段）后 model-management **939 个用例**
与宿主 **639 个用例**全绿——即这条判定当时**无任何覆盖**。它是跨组织可见性的兜底（`model.organization_id`
是随 Provider 冗余下来的列），删掉没有编译 / 类型信号，因此必须有可执行断言钉住。已补
`packages/resources/model-management/src/__tests__/model-label-lookup.test.ts`（5 例：同组织命中 /
Provider 属别组织不产出 / Provider 行缺失不产出 / 展示名回退 / 空入参不查库），并**复跑同一变异确认新用例
报红**（「删条件必须失败」是该覆盖的有效性判据，不是写完即可）。本批的其余契约测试由同一轮审计的另外三个
视角负责，未产出结论（工作流随会话中断）。

**状态**：见本批提交（§五 表 B3 行）。

### 7.13 B4 前置：沙盒实例投影写路径移到 sandbox 侧（2026-09-22，本批）

**为什么单独一批**：`machine → sandbox` 是 §2.3 的类别禁则，`machine-sandbox-projection.ts` 在
`sandbox_instance` 迁出后无法靠改 import 解决（§6.1 的组装期例外只覆盖 `packages/**/db/**`，该文件在
`src/server/services/` 下）。用户裁定「投影写路径移到 sandbox 侧」（§4.8 第 3 条），并要求作为 B4 的**前置
小任务**独立交付——不在「只搬表定义」批次里做（该重构改的是 machine 的投影触发链，与迁表无关）。
本批落地后 §8.4 第 2 条闭环、§四 的 B4 批级阻塞解除，B4 主体回到纯迁表。

**交付面**：

1. **machine 新增对外通知端口** `src/server/machine-lifecycle-port.ts`：`notifyMachineRegistered` /
   `notifyMachineHeartbeat`（入参 `(machineId, at)`），导出 `bind*` / `get*` / `reset*ForTest`。
   **未绑定是正常状态**（assembly profile 不含沙盒模块时本包静默跳过通知，那时也没有实例行），
   与 `host-port.ts` 的 fail-fast 语义刻意不同。
2. **删除** `src/server/services/machine-sandbox-projection.ts`（`git rm`）与其测试
   `src/__tests__/machine-sandbox-projection.test.ts`。
3. **触发点改通报**：`registry.ts` 的注册路径与 `registry-heartbeat.ts` 的 `handleHeartbeat` 各改一次调用。
   **事件时刻由调用方给出**（`new Date()` 在 machine 侧取）：投影写入的时间戳因而可被用例断言，而不是藏在
   接收方内部——与 `at = new Date()` 默认参数相比，这条口径让「谁决定时刻」在类型上就写明。
4. **sandbox 侧实现**：`src/server/repositories/sandbox-instance-repository.ts` 新增
   `markSandboxInstancesReadyForMachine`（按 `machine_id` 批量把 `creating` / `starting` / `recovering`
   提升为 `ready` 并同步心跳）与 `touchSandboxInstancesHeartbeatByMachine`（只更新时间戳）。
5. **装配绑定**：`src/module.ts` 的 `createSandboxModule()` 内绑定（紧邻既有的
   `bindMachineSandboxRoutePort`），方向仍是 sandbox → machine。
6. **测试迁移**：新增 `sandbox/src/__tests__/sandbox-instance-machine-projection.test.ts`（3 例，
   用 `stubDb` 捕获 `set` 载荷 + `PgDialect().sqlToQuery` 断言 where 参数）；`machine-resource-surface.test.ts`
   重写为「端口已公开 + 投影实现不得回到本包出口」的正反两条；`machine-package-contract.test.ts` 的
   宿主导入正向控制由 3 项收缩为 2 项、扫描清单换文件；两个既有用例（`round36` / `round68`）改为断言
   「经端口通报」而非「本包直接写表」。

**为什么不需要宿主改动、manifest 改动或 §2.3 新例外**：`sandbox` 的 `dependsOn` 已含 `machine`，绑定发生在
沙盒自己的 `createSandboxModule()` 内，machine 不反向依赖；这与该包已有的 `MachineSandboxRoutePort`
（machine 定义、sandbox 自行绑定、未绑定=正常降级）**完全同形**，属已有机制而非新设施。

**为什么「终态不得被复活」的判定留在 sandbox**：`destroyed` / `error` 不在提升集合内、心跳只写
`last_heartbeat_at` 不碰 `status`——「哪些状态算中间态」是沙盒实例状态机的领域知识，与表同 owner。
本批把这层知识从 machine 的 UPDATE 语句里搬回它的 owner，是这次重构的实质收益（改表定义的 import 只是表象）。

**§4.7.1 交付面的适用性**：①（调用期读取点经 owner 公开入口 / 宿主注入端口）**方向相反**——本批消除的是
一处**跨包写**；②（owner `db/schema.ts` 声明跨包导入）不适用，本批不迁表、不新增 `./db` 导入；
③（source-migration 契约测试正向控制收缩）**适用**：machine 包的正向控制已按本批同步收缩（见交付面第 6 条）；
④（调用期跨包写一并处理）本批即为此条而生——它正是 B1 实测登记的「两处调用期跨包写」之一（§4.8 第 7 条）。

**验证**：`bun test packages/resources/machine packages/resources/sandbox` **651 pass / 1 fail**
（唯一失败是 `fs-download-zip.test.ts` 在受限 PATH 下拿不到 `zip` 可执行文件，与本批无关，`which zip`
在交互 shell 下存在）；`bun test apps/server/src/__tests__/` **639 pass / 0 fail**；
`grep -rn 'sandbox_instance' packages/resources/machine/src` 在**生产代码**上为 0 行
（全包共 5 行命中，全部是注释与断言文本：`machine-lifecycle-port.ts` 文件头的历史说明 2 行、
`machine-resource-surface.test.ts` 的反向守卫说明、`machine-package-contract.test.ts` 的迁移注记、
`remote-file-service.test.ts` 的用例注释；原写「为空」是拿全包 grep 口径当生产口径，订正见 §7.16）；
`precheck` 全绿（见提交）。

**状态**：见本批提交（§五 表 B4 前置行）。

### 7.14 B4：`sandbox_pool` / `sandbox_instance` 迁至 `@fenix/resource-sandbox/db`（2026-09-22，本批）

**本批是纯迁表。** B4 的批级阻塞（`machine → sandbox` 类别禁则）已随 §7.13 的前置小任务解除，本批没有
需要先定夺的事项。

**交付面（对照 §4.7.1 四条）**：

1. **①调用期读取点经 owner 公开入口取数——天然满足，无落点。** 实测本包与宿主**都不存在**对这两张表的
   跨包调用期表对象读写：宿主对沙盒的使用全部走公开入口（`initializeDefaultSandboxPool`、沙盒路由工厂、
   模块配置），包内读取本就由本包仓储承担。因此本批 ① 没有可收口的点（与 B2 / B3 不同）。
2. **②owner `db/schema.ts` 的每处跨包表对象导入都须声明该包。** 本包 `db/schema.ts` 从 `@fenix/identity/db`
   导入 `organization` / `user`，表达 2 条级联外键（`sandbox_pool.organization_id`、`sandbox_instance.user_id`）；
   `package.json` 同批新增 `"@fenix/identity": "workspace:*"`——§6.1 的 `db/` 例外只豁免 `special-dependency`，
   这条 `undeclared-workspace-dependency` 不豁免（§4.8 第 5 条）。**`machine_id` 不导入 machine 包**：
   它在历史 DDL 上就是无外键约束的普通列，迁表只搬既有 DDL、不得顺手加约束，因此本包不因它依赖
   `@fenix/resource-machine/db`（该包仍是本包依赖，但那是 `MachineSandboxRoutePort` 的成因，与迁表无关）。
3. **③source-migration 契约测试的正向控制必然失效，本批收缩为负例夹具。** 本包
   `src/__tests__/sandbox-source-migration.test.ts` 原有「`@server/db/schema` 残留 **9 处 / 9 个文件**，除该
   精确路径外零命中」的断言 + `ALLOWED_HOST_IMPORT` 唯一放行常量，这正是「本包尚欠宿主表定义」的守护。表
   迁出后它扫不到任何东西——**此刻「扫不到」才是正确结果**，正向控制因此反向失效。处置：
   - 删除 `ALLOWED_HOST_IMPORT` 常量与随之无用的注释；
   - 判据由「等于该精确路径的列表」收缩为「**不以 `@server/` 开头**」（零容忍），测试名改为
     「包内不存在任何宿主 `@server` 导入」；
   - 新增 `SCANNER_FIXTURE` 负例夹具承担原职责：一段按真实源码形状拼成的字符串，含一行宿主导入与一行
     「**块注释里**形似导入」的文本（块注释形状是 2026-09-22 审计整改的结果，初稿用的行注释形状只验证了
     一半，见 §7.18），断言扫描器把前者捞出、把后者剥掉。
   **为什么不能只是删掉断言**：扫描器（`stripComments` + `extractSpecifiers`）是本测试自写的，仓库里没有
   别的用例钉住它；夹具是唯一能把「此刻恰好扫不到」与「扫描器已坏」区分开的装置。夹具按行以字符串字面量
   拼成，源码里 `import` 前始终有引号，不会被本文件对自身的真实扫描误判（导入口径 `@server/` 命中 0 处；
   文本口径的 14 处命中明细见 README「边界残留」一节，2026-09-22 订正）。
4. **④调用期跨包写。** §4.8 第 7 条登记的两处（machine 写 `agent_config.machineId`、agent-config 写
   `environment`）都不在本包；本包曾有的那一处（machine 写 `sandbox_instance`）已在 B4 前置处置（§7.13）。

**实际改动**：

- 新建 `packages/resources/sandbox/db/schema.ts`：`sandboxPool` / `sandboxInstance` 两表 + 4 个推断类型
  （`SandboxPool` / `NewSandboxPool` / `SandboxInstance` / `NewSandboxInstance`）。DDL 逐字保留（列序、`varchar`
  长度、`timestamp` 模式、索引名与唯一索引），文件头注释写明两个跨包外键目标与「`machine_id` 无约束」的理由。
- 宿主 `apps/server/src/db/schema.ts` 删除同名两表 + 4 类型（**净 −57 行**：`--numstat` 为 `1 增 / 58 删`；
  §7.14 初稿写的「−59」是 `--stat` 的**变更总行数**，把增删相加了，2026-09-22 审计订正）。顶部 `organization`
  导入随之收窄为 `user`（`organization` 在宿主 schema 中的唯一用处就是 `sandbox_pool.organization_id`）；
  `organization` 仍经宿主顶部的 `export { … organization … } from "@fenix/identity/db"` 转出，对经宿主 barrel
  取身份表的消费者无影响。
- `drizzle.config.ts` 的 `schema` 数组新增本包 `db/schema.ts`，注释同步（不声明会让 `db:generate` 把这两张表
  误判为已删除）。
- **9 处导入改指本包出口**：生产 6 个文件（`repositories/sandbox-{instance,pool}-repository.ts`、
  `services/sandbox-{admin-service,default-pool,manager,remote-reconciler}.ts`），测试 3 个文件
  （`sandbox-default-pool.test.ts`、`sandbox-manager-fixtures.ts`、`sandbox-schema.test.ts`）——`grep -rn
  "@fenix/resource-sandbox/db" packages/resources/sandbox apps/server/src` 在同一提交上实测 9 条导入。
  **§7.14 初稿写「10 处…测试 4 个文件」并把 `sandbox-source-migration.test.ts` 列入，是错的**：该文件
  从不导入本包 `db`，它是**检测**旧表定义导入的那一方（现在则断言零残留）。这条错报与同批 README 的
  「此前 9 处」、以及被替换掉的旧断言原文「残留 9 处 / 9 个文件」三处自相矛盾，2026-09-22 审计订正
  （同批提交信息里也写了「10 处」，commit message 不可改，记此备查）。
- `src/server/db.ts` 的句柄类型注释同步：**未改动类型形状**——迁表前那句「刻意不写 `typeof schema`，迁出后
  无需改动」的承诺本批被证实（`SandboxDatabase = NodePgDatabase<Record<string, never>>` 原样保留）。

**台账条目为什么本批能删，而 B1–B3 都不能**：§4.8 第 2 条把删除时机定为「该包**最后一个跨模块表读取**消失」，
不是「该包自己的表迁完」。B4 是第一个两条同时成立的批——本包自己的表迁完，且包内不存在任何别的包的跨模块
表读取（machine 的 `agent_config` 读取不在本包）。删除前 `architecture:check` **自己报出**「`apps-boundary
@fenix/resource-sandbox → @fenix/server-app` 有 1 条已不再违规，必须删除」（stale 检测），这就是「残留归零」
的机器证据，比逐条 `grep` 更强。删除后 2127 files / **18 条**已登记例外（原 19）。**machine 包的条目同批不能删**：
它仍有 1 处 `agent_config` 读取（归 B7）。

**验证**：`check:schema-ddl-drift` ✓ 零差异（DDL 逐字搬家）；`architecture:check` ✓ 2127 files / 18 条例外；
`bun test packages/resources/sandbox` **109 pass / 0 fail**（22 files）；`bun test apps/server/src/__tests__/`
**639 pass / 0 fail**（46 files）；`bun test packages/resources/machine packages/resources/sandbox` **656 pass /
0 fail**（66 files）——B1 起就存在的 `fs-download-zip.test.ts` 受限 PATH 失败本次未复现（`which zip` 可用），
与 B4 前置那次记录的环境噪声同源，非本批引入；`precheck` 见提交。

**状态**：见本批提交（§五 表 B4 行）。

### 7.15 B5：`skill` 迁至 `@fenix/resource-skill/db`（2026-09-22，本批）

**交付面（对照 §4.7.1 四条）**：

1. **①调用期读取点收口（本批的主体工作量）。** 跨包读取点只有一处：
   `packages/resources/agent-config/src/server/services/agent-related-resources.ts:107-110` 直接 `select`
   `skill` 表取展示标签。本包 `fenix.module.ts` 的 `dependsOn: []` 是「叶子模块」，而 agent-config 的
   `dependsOn` 已含 `skill`，方向合法——因此按 **B2 的 mcp 先例**走「owner 公开入口」而不是宿主注入端口：
   - 新增 `findSkillLabelsByIds(ids)`（`src/server/repositories/skill.ts`），经
     `@fenix/resource-skill/server/config` 再导出。**入口与形状都对齐 mcp 的
     `@fenix/resource-mcp/server/config`**（B2 定型：关联表读写 + 关联 id 的展示标签投影同处一个窄出口），
     `src/server-config.ts` 的文件头随之改写为「`@fenix/resource-agent-config` 的取数面」。
   - **取数语义逐字保留**：不按 `visibility` 过滤、不按组织过滤（`name` 非敏感字段；按可见性过滤会让
     「曾经绑定过但已不可见」的技能退化成裸 ID，与迁移前行为不一致）、空入参不查库。调用方因此从
     「自己拼 SQL」退回「拿绑定表给出的 ID 集合换名字」这一层视图语义（与 `resolveModelLabel` /
     `resolveMachineLabel` 同构）。
   - 该文件的头注释按同一口径改写：「跨包表的两类读法」清单里 `skill` 从「仍经 `@server/db/schema`」
     移入「经对方已声明的公开入口」，余下 `knowledge_base`（B9）与 `agent_site_app`（B7）保持原状。
2. **②owner `db/schema.ts` 声明跨包导入。** 新建 `packages/resources/skill/db/schema.ts`，从
   `@fenix/identity/db` 导入 `user` 表达 `skill.user_id` 的级联删除；`organization_id` 历史 DDL 上就是
   无外键约束的 text 列，故**不**导入 `organization`。`package.json` 同批新增 `"./db"` 出口与
   `"@fenix/identity": "workspace:*"` 声明（§6.1 的 `db/` 例外只豁免 `special-dependency`）。
   **不导出 `$inferSelect` 推断类型**：本包仓储自持 `SkillRow`，没有第二个消费者，与 machine / mcp /
   model-management 三个先例一致（只有 sandbox 导出，因为它的仓储确实引用了那两个类型）。
3. **③source-migration 契约测试收缩。** `src/__tests__/skill-source-boundary.test.ts` 的「`@server/db/schema`
   残留清单」由 **3 项收缩为 1 项**（只剩 `src/server/repositories/agent-config-skill.ts` 读关联表），
   `ALLOWED_HOST_IMPORT` 常量**保留**并补注释说明它现在只服务于 join 表。
   **与 B4 的处置刻意相反**：B4 的残留归零，正向控制反向失效，故改成零容忍断言 + 负例夹具自检；本包的
   关联表是**尚未迁出的真实残留**，此刻「扫得到」才是正确结果，改成零容忍只会得到一个当下必红的断言。
   两批的差别只有一件事——本包还有没有真实残留。
4. **④调用期跨包写。** 本批无。§4.8 第 7 条登记的两处都不在本包；宿主
   `services/data-migrates/backfill-resource-visibility.ts` 对 `skill.visibility` 的写入是**宿主部署期**
   数据迁移（release 步骤执行一次），按 §4.7.1 第 1 条的用户裁定登记为 carve-out，处置与 B2 / B3 逐条相同
   （只把 `skill` 的导入改指本包 `./db`，`agent_config` / `resourcePermission` 仍取宿主 schema）。

**实际改动**：新建 `db/schema.ts`（表 + 两条索引，DDL 逐字保留）；宿主 `apps/server/src/db/schema.ts` 删
该表并改为 `import { skill } from "@fenix/resource-skill/db"`（`agent_config_skill.skill_id` 的外键要用列对
象表达，宿主是唯一同时持有两侧定义的装配层，口径同 B3 的 `agent_config.model_id`）；`drizzle.config.ts`
声明新路径；包内 2 处导入改指本包出口（`access/skill-resource.ts`、`repositories/skill.ts`）；
`src/server/db.ts` 的句柄类型注释同步（**形状未改**）；`agent-config` 的关联资源视图改经公开入口取标签，
`round45-agent-config-routes-coverage.test.ts` 的桩行由 `{ id, label }` 改为 `{ id, name }`（投影改读
`skill.name` 后，`label` 别名不再存在——这条桩行改动本身就是「取数换手」的证明）。

**补测（把 B3 审计的教训前置，不等审计来发现）**：B3 的同类投影 `findModelLabelsByIds` 曾被审计变异实验
证明「组织一致性判据无覆盖、删掉 939+639 个用例全绿」（§7.12 补测段）。本批交付同一形态的新投影时即带上
覆盖：新增 `src/__tests__/skill-label-lookup.test.ts`（3 例：批量取 `name` / 查不到的 id 不造值 /
空入参不查库），并**做变异确认**——删掉 `if (ids.length === 0) return new Map();` 守卫后
「入参为空时不查库」报红，还原后复绿。

**台账条目按实测改写但保留**：`apps-boundary @fenix/resource-skill → @fenix/server-app` 的 `rationale`
由「3 处导入 / 3 个文件」改为「1 处导入 / 1 个文件」（只剩关联表），`removeWhen` 改指 B7 的 join 表归属
定夺。判据与 B4 删条目用的是同一条（§4.8 第 2 条「该包最后一个跨模块表读取消失」），结论不同只因事实不同：
B4 的残留归零，本包的残留还在。

**验证**：`check:schema-ddl-drift` ✓ 零差异；`architecture:check` ✓ 2129 files / 18 条例外（条目保留，
`rationale` 更新不改变条数）；`check:dependencies` ✓ 2270 modules / 0 条新增违规；`generate:module-registry
--check` ✓ 17 模块；`bun test packages/resources/skill packages/resources/agent-config apps/server/src/__tests__/`
**1626 pass / 0 fail**（118 files）；`precheck` 见提交。

**状态**：见本批提交（§五 表 B5 行）。

### 7.16 B4 前置审计整改：装配接线覆盖、端口降级语义与取证口径（2026-09-22，本批）

对 B4 主体（`184adae63`）与 B4 前置（`0108b9d4a`）做了一轮独立审计（26 个代理、四视角 + 逐条反驳，
22 条原始发现，**确认 9 条、驳回 13 条**）。确认项**没有一条是代码行为缺陷**，全部是「覆盖是否真的
抓得住」与「文档取证口径是否属实」两类。本批逐条整改如下。

**一、装配接线零覆盖（确认项中最重）**

- **发现**：`createSandboxModule()` 内那一次 `bindMachineLifecyclePort(...)` 是「机器事件 → 沙盒实例投影」
  真正发生投影的**唯一生产接线**。审计做了变异——把两个通知实现**对调**、以及把整段绑定**换成 no-op**，
  `apps/server/src/__tests__/` 639 例与 machine + sandbox 656 例**全绿**，而生产里实例会永久停在
  `creating` / `starting` / `recovering`（`sandboxManager.recoverAfterRestart()` 的恢复链靠这条投影闭环）。
  成因：三段（通报 / 投影 / 接线）各有用例，唯独把两段接起来的那一行没有；`git grep -n 'createSandboxModule'
  0108b9d4a -- '*/__tests__/*' '*.test.ts'` → 0 命中。
- **整改**：新增 `packages/resources/sandbox/src/__tests__/sandbox-module-wiring.test.ts`（3 例）。
  断言用**函数同一性**（`expect(port?.notifyMachineRegistered).toBe(markSandboxInstancesReadyForMachine)`），
  同时抓得住「对调」与「换空实现」两种变异；再加一例端到端旁证（经端口通报一次，断言写出的载荷与仓储
  自己的投影逐字一致），封堵「绑了个什么都不做的包装层」这类绕开同一性断言的改法；路由端口（
  `resolveSandboxRoute`）一并钉住。
- **变异确认**：把 `module.ts` 里两个通知对调 → **2 fail**（同一性 + 载荷）；还原后复绿。

**二、`MachineLifecyclePort` 的「未绑定=正常降级」无断言，且端口跨文件泄漏**

- **发现**：本端口与 `host-port.ts` 语义**刻意相反**（host port 未绑定即失败，本端口未绑定是正常状态），
  但这条差异只有注释在说：`round36` / `round68` 都在 `beforeEach` 里绑记录器，**没有一条用例跑在「未绑定」
  这个状态下**。
- **发现（泄漏）**：两处 `afterEach` 只清 `lifecycleCalls`、不 `resetMachineLifecyclePortForTest()`，
  而 `Bun` 在同一进程跑完整个包——端口带着上一个文件的记录器存活到下个文件。审计证据：变异
  「`getMachineLifecyclePort()` 未绑定即 throw」下全包绿，单跑 `round39` 则 4 红，即**顺序相关的假绿**。
- **整改**：新增 `packages/resources/machine/src/__tests__/machine-lifecycle-port.test.ts`（5 例）——
  未绑定读取返回 `null`；未绑定端口时**注册路径**照常完成（钉住 `registry.ts` 调用点的可选链）；
  未绑定端口时**心跳路径**照常完成（钉住 `registry-heartbeat.ts` 的可选链）；绑定守卫的两条语义
  （二次绑定**不同**实现报错、重复绑定**同一**引用放行）一并钉住。同时给 `round36` / `round68` 的
  `afterEach` 补 `resetMachineLifecyclePortForTest()`（文件内注释写明「只在 beforeEach 里 reset 会
  让端口跨文件存活」）。
- **变异确认**：让 `getMachineLifecyclePort()` 未绑定时抛错 → 新文件 **3 fail**、而 `round36` + `round68`
  仍 **99 pass / 0 fail**——审计给出的「旧用例全绿」结论逐字复现；还原后复绿。

**三、四处取证口径与计数订正（均为本批之前引入）**

| 位置 | 原写 | 实测 | 订正 |
|---|---|---|---|
| 评审文档 §7.13 验证段、§8.4 第 2 条 | `grep -rn 'sandbox_instance' packages/resources/machine/src` **为空** | 全包 5 行命中，全是注释 / 断言文本（端口文件头 2 行、`machine-resource-surface.test.ts` 反向守卫、`machine-package-contract.test.ts` 迁移注记、`remote-file-service.test.ts` 用例注释）；**生产代码 0 行** | 改为「生产代码 0 行」并列出 5 处命中的出处 |
| `scripts/architecture/exceptions.json`（machine 条目 `rationale`） | 同上一句 | 同上 | 同上，并补「生产侧 `from "@server` 前缀只命中 `src/server/services/registry.ts` 一个文件」 |
| `packages/resources/machine/README.md:256` | 「本包 `src/**` 不再出现 `sandbox_instance`」 | 同上 | 改为「不再有**写**它的代码路径」+ 命中明细 |
| `packages/resources/machine/README.md:181` | 「§1.7 B1 后剩 **2 个生产文件 + 1 个测试文件**」 | 1 个生产（`registry.ts` 的 `agent_config`）+ 2 个测试（`registry-schema.test.ts`、`machine-package-contract.test.ts` 的常量）——与同文件 :127 自相矛盾 | 改为「1 个生产文件 + 2 个测试文件」并写明是哪几个 |
| `packages/resources/sandbox/README.md:34` | `grep -cE "^export" src/server.ts` → **22** | **23** | 改为 23（非本批引入） |
| `packages/resources/sandbox/README.md:35` | `getSandboxDatabase` → **23 处**、`getSandboxDatabase()` → **21 处** | **25 处** / **23 处**（命中仍只落在 `db.ts` 与两个 repository） | 改为 25 / 23（B4 迁表后计数变化，本批前未同步） |

**为什么「grep 为空」这类写法要订正而不是放宽**：本批的两个表迁移都以「grep 命中数」作为边界证据，
而全包 grep 会把**注释、断言文本、扫描器夹具**一并算进去。B4 自己的测试（零容忍断言 + 负例夹具）与
B5 的残留清单正是靠这些文本存在，口径混淆会让人误以为「代码路径已归零」，也会在下一次迁移时把
测试文本当成待清理的残留。

**验证**：`bun test packages/resources/machine packages/resources/sandbox` **664 pass / 0 fail**（68 files，
B4 前置为 656，+8 = 新增 5 + 3）；`bun test apps/server/src/__tests__/` **639 pass / 0 fail**（46 files）；
两次变异实验均已还原并复跑确认；`precheck` 见提交。

**状态**：见本批提交 `test(ce-ee): 1.7 B4 前置 补装配接线覆盖并订正取证口径`。

### 7.17 B6：Workflow 九张领域表迁至 `@fenix/resource-workflow/db`（2026-09-22，本批）

**范围**：`workflow`、`workflow_version`、`workflow_run`、`workflow_event`、`workflow_snapshot`、
`workflow_node_output`、`workflow_board`、`workflow_job`、`workflow_trigger`——§4.7 表中 B6 的
「9 张」，按拓扑序无跨包外键依赖。本批是 B 块迄今**最小**的一批：包内只有 3 处生产导入点，
**没有任何别的包读这些表**。

**为什么是「最小批」——一次实测而非估计**：全仓扫 `workflowTrigger` / `workflowSnapshot` /
`workflowNodeOutput` / `workflowVersion` / `workflowBoard` / `workflowEvent` / `workflowJob` 的引用，
命中只有本包 3 个生产文件、本包 1 个测试文件、宿主 `db/schema.ts`（定义处）与
`apps/server/src/test-utils/stubs/module-stubs.ts`（只有注释提到 workflow，无表对象引用）；宿主
`src/__tests__/` 里 5 个含 "workflow" 的文件的命中全是**路由名、缓存键、注释**，无一条断言 workflow
表。因此 B6 没有「跨包读取点」这一类交付面。

**表间外键在本包内闭合，宿主不再需要它们的表对象**：`workflow_version` / `workflow_run` /
`workflow_job` / `workflow_trigger` → `workflow`，`workflow_job` → `workflow_board`，全部落在新文件内；
宿主任何表都不引用 workflow 表。这与 B1–B5 各批**不同**——那几批宿主都要留一行 `import` 供
`agent_config.*` 的跨包外键使用，本批宿主 `schema.ts` 里连 `import` 都不需要（头部注释已写明
「第六批不在这份清单里」）。唯一跨包外键目标是身份表（4 条级联删除 → `@fenix/identity/db` 的 `user`）；
`organization_id` 各列历史 DDL 上都是无外键约束的 text 列，故不导入 `organization`（与 B4 的
`sandbox_instance.machine_id`、B5 的 `skill.organization_id` 同一口径）。

**实际改动**：新建 `packages/resources/workflow/db/schema.ts`（九张表逐字搬迁，附分节注释）；
宿主 `apps/server/src/db/schema.ts` 删除该段（−225 行，含两行历史损坏的分隔注释，见下）；`drizzle.config.ts`
声明新路径；`package.json` 新增 `./db` 出口与 `@fenix/identity`；包内 3 处导入改指
`@fenix/resource-workflow/db`（`repositories/workflow-def.ts`、`repositories/workflow-trigger.ts`、
`services/workflow/pg-storage-adapter.ts`）；`src/module.ts` 与 `src/server/db.ts` 的注释口径同步
（**形状未改**，`db.ts` 仍刻意不写 `typeof schema`：迁表前它解开的是对宿主 schema 类型的耦合，迁表后
同样不必耦合自己的 schema 聚合）。

**④调用期跨包写**：本批无。§4.8 第 7 条登记的两处（`agent-runtime` 的两处 LEFT JOIN）都不在本包；
本包对 `agent_config` 的取数是经 `@fenix/agent-config` 的公开入口，不是表级读写。

**台账条目删除，由门禁自证**：`apps-boundary @fenix/resource-workflow → @fenix/server-app` 整条删除。
删除理由不是「本包自己的表迁完了」，而是**该包最后一个跨模块表读取消失了**（§4.8 第 2 条的判据）——
实测包内 `@server/**` 残留归零。`architecture:check` 的 stale 检测是本判据的充分证据：先跑一次，
门禁主动报「有 1 条已不再违规，必须删除」并指名该条目，删后复跑 `✓ 2132 files / 17 条例外`
（B4 后为 18 条）。

**正向控制反向失效 → 改零容忍 + 负例夹具（与 B4 同形、与 B5 相反）**：
`workflow-source-migration.test.ts` 原先的「残留清点 + `HOST_TABLE_USAGE_ALLOWLIST` 白名单相等」两条
用例随残留归零而失效——删除 `ALLOWED_HOST_IMPORT` 与白名单，改为
`test("包内不存在任何宿主 @server 导入")` 的零容忍断言，并把「扫不到是扫描器坏了还是真没有」的职责交给
`SCANNER_FIXTURE` 负例夹具自检（一段真实源码形状的字符串：一条宿主导入必须被捞出、一条**注释里**形似
导入的文本必须被剥掉）。判据与 B4/B5 逐字相同：**看本包还有没有真实残留**。同批把「路由不直接访问
数据库」用例的违规说明符从 `@server/db/schema` 换成 `@fenix/resource-workflow/db`——迁表后路由仍不得
绕过仓储层，只是绕道的入口换了名字（漏改的话这条守卫会静默失效）。

**顺带记录的问题（非行为改动）**：宿主 `schema.ts` 被删段里，`workflow_board` 与 `workflow_job`
头上两行分隔注释含**历史 UTF-8 损坏**（`od` 实测有非法字节，`grep` 显示为 `─���─`）。它在注释内、
不影响任何 DDL 或运行时，随本段删除一并消失，新文件写的是完好注释。不单开修复提交。

**验证**：`check:schema-ddl-drift` ✓ 零差异（DDL 逐字搬迁的直接证据）；`architecture:check` ✓
2132 files / 17 条例外（stale 检测先报错、删条目后归零）；`check:dependencies` ✓ 2274 modules /
0 条新增违规；`bun test packages/resources/workflow` **725 pass / 0 fail**（43 files）；
`bunx tsc --noEmit` ✓；`precheck` 见提交。

**状态**：见本批提交（§五 表 B6 行）。

### 7.18 B4 主体审计回收：夹具判别力、`db/` 扫描集与取证口径（2026-09-22，本批）

**审计形态**：对 B4（`184adae63`）交付面跑了一轮多代理主体审计（46 个代理、约 278 万 subagent token、
耗时约 28 分钟），产出 `confirmed 13 / disputed 5 / rejected 3`。本节记录逐条处置。判据沿用本任务既有
口径：**能改代码的先改代码并用变异实验双向证实；纯口径不实的改文档并写明订正理由；不成立的给出理由。**

#### 一、测试有效性（两条，唯一需要改代码的）

1. **负例夹具只验证了一半**（confirmed[3]/[8]，major）。`SCANNER_FIXTURE` 里「注释中形似导入必须被
   剥掉」这半条此前**恒真**：三条 `SPECIFIER_PATTERNS` 的 `from` 形式带 `^[ \t]*` 行首锚点，而行注释
   `// import …` 的行首是 `/` 不是 `import`，未剥注释时本就不在候选集里。**变异实测**：把
   `stripComments` 改成 `return source;` 后，夹具断言（原第 238 行）**仍全绿**，报红的只有
   `process.env` 那条无关用例——即「两者任一失效即报红」的表述是假的，夹具当时只能证明「说明符提取
   正则没坏」。
   **处置**：夹具的注释行改为**块注释形状**（中间行行首正是 `import`），断言拆成两条，并新增
   `SCANNER_FIXTURE_COMMENTED` 常量：未剥注释时两条说明符**都要**被捞出（证明夹具本身有区分力），
   剥掉后只剩真实导入（证明 `stripComments` 在起作用）。两处契约测试（sandbox 黄金样本 + workflow）
   同形处理。
2. **`db/**` 没有被任何正向控制钉进扫描集**（confirmed[4]，minor）。`toContain` 清单点了 `src/`、
   `web/`、`fenix.module.ts`，唯独漏了本批表定义的新家；`sourceFiles.length >= 60` 的阈值比实际文件数
   低 20 余，掉一个目录也兜不住。**变异实测**：从 `SOURCE_ENTRIES` 删掉 `"db"` 后整套仍全绿，此时往
   `db/schema.ts` 插一条真宿主导入也不报红——「本包确实扫不到」与「`db/` 根本没进扫描集」无法区分。
   **处置**：两份契约测试各把 `db/schema.ts` 加进 `toContain` 清单。

**变异证据（整改后，四轮各自备份 → 注入 → 跑 → 还原 → `cmp` 校验）**：`stripComments` 改恒等 →
sandbox / workflow 的**夹具断言自身**各报红（整改前该条恒绿）；`SOURCE_ENTRIES` 删 `"db"` →
两份的遍历有效性自检各报红 1 条。还原后 26 pass / 0 fail。代码改动随 `d549e0838` 单独提交。

#### 二、取证口径订正（七处，全部是「写下的数字与命令实测不符」）

| 位置 | 原文 | 实测 | 处置 |
|---|---|---|---|
| sandbox `README.md:3` | 宿主「只剩挂载与装配调用（`routes/web/config/index.ts` 调 `createWebSandboxPoolsRoutes`，`main.ts` 调 `createApiSandbox*Routes`）」 | 这两个文件**零** sandbox 引用；`createApiSandbox*Routes` 是**本包 assembly 的导出名**，宿主从不调用。生产装配经本包 `fenix.module.ts` 的四条 `app-route` 贡献 → `src/server/assembly.ts`；宿主里直接点名四个工厂的只有测试工具 `route-faces.ts` | 改写整句并留订正说明（confirmed[12]，minor / doc-truth） |
| sandbox `README.md:53` | 「生产代码实测 `grep -rnE '@server' src web db fenix.module.ts` → 0 处」 | 该命令实测 **14 处**命中（审计当时 12 处；本节第一部分把夹具改成块注释形状并新增一个常量后 +2），其中 `web/index.ts:4` 是**生产文件**（注释文字）。把文本口径误记成导入口径，掩盖了那一处 | 拆成**导入口径**（`@server/**` 导入 0 处，9 处表定义导入改指本包出口）与**文本口径**（14 处命中明细：`web/index.ts:4` 1 + `sandbox-source-migration.test.ts` 7 + `sandbox-browser-surface.test.ts` 6）并留订正说明（confirmed[9]，**major** / doc-truth） |
| workflow `README.md:68` | 「生产代码实测 `grep -rn 'from \"@server/' src web db fenix.module.ts` → 0 处」 | 该命令实测 **2 处**命中，都在 `workflow-source-migration.test.ts` 的夹具字符串字面量里 | 同形拆成两个口径并留订正说明（与上条同类，审计未单列——**审计只审了 B4，这条是本批自查发现的同形缺陷**） |
| workflow `fenix.module.ts:23` | 「`@server/db/schema`：`src/**` 生产代码只剩这一条宿主内部依赖（表定义，§5 残留，owner 1.7 迁出）」 | **B6 把这条依赖删掉了**，注释没同步：「四类边」变三类，bullet 本身应整条删除 | 删 bullet、改「三类边」、补一段说明迁移后的机器证据（**B6 交付的遗漏注释**，本批自查发现） |
| §7.14:740 | 「**10 处**导入改指本包出口……测试 **4** 个文件（含 `sandbox-source-migration.test.ts`）」 | 实测 **9 条** import（生产 6 + 测试 3）；该文件从不导入本包 `db`，它是**检测**旧表定义导入的那一方 | 改为 9 处 / 测试 3 个文件，并写明与 README「此前 9 处」、旧断言「9 处 / 9 个文件」三处自相矛盾的原因（confirmed[1]/[7]/[11]，三条重复主张；commit message 里也写了「10 处」，不可改，记此备查） |
| §7.14:734 | 「（−59 行）」 | `--numstat` 实测 `1 增 / 58 删`，**净 −57**；59 是 `--stat` 的**变更总行数** | 改为「净 −57 行」并注明口径来源（confirmed[10] + disputed[0]，同一主张的两种计票） |
| §8.4 第 4 条 | 「B4 已收口 1 处……余 15 处」 | 19 处是**读**口径，B4 消除的是**跨包写**（machine 写 `sandbox_instance`），不在 19 处内；B4 也在 §7.14 ① 自述「本批 ① 没有可收口的点」 | 改为「余 **16 处**」= 19 − B2 1 − B3 1 − B5 1（B4 记 0、B6 记 0），并把「B4 不适用读口径」写进同一行（rejected[1] 与 disputed 的计票分歧由此统一） |
| §7.14:612 段 + §7.18 末条 | 「本包与宿主的边界由 `apps-boundary` 台账 + `check:dependencies` 承担」 | `undeclared-workspace-dependency` / `apps-boundary` 由 **`architecture:check`**（`scripts/lib/architecture-boundary-rules.ts:124`）拦，**不在** `check:dependencies` 里（实测删掉 `@fenix/identity` 声明后 `check:dependencies` 全绿、`architecture:check` 报错）；precheck 两步都跑，所以「边界仍被强制」的结论不变 | 在原句补分工说明（confirmed[5] 指出的是**审计简报**的命令选错，不是文档写错；文档这处顺手写清以免读者误解） |

#### 三、不予采纳的审计主张（disputed 5 + rejected 3 中无实质动作的部分）

- **「工作树被并发会话/代理改脏，`module.ts` 的端口实现被换成空实现」（confirmed[6]）、「审计期间有
  并发代理在做 B5、导致 `check:schema-ddl-drift` 必然失败」（disputed[2]）、「工作树被并发写入，本地
  实测不可信」（disputed[4]）、「被审文件第 1 行有未还原的注入」（rejected[2]）**——四处指向同一现象，
  归因不实：那是**审计自身的变异实验就地改了工作树**（finding[4] 自己描述了往 `db/schema.ts` 注入、
  finding[3] 描述了改 `stripComments`），不是别的会话。**处置**：本批开工前先跑 `git status --porcelain`
  → 空；`module.ts` 的端口绑定经 `grep -n "notifyMachineRegistered:"` 复核仍在第 43 行指向
  `markSandboxInstancesReadyForMachine` 的正确实现（§7.16 那批的变异在提交前已 `cmp` 还原）。
  **可迁移的教训**：审计代理做变异实验后必须还原并复核——本任务已把它写进流程约束；而审计报告对
  工作树污染的归因不能当作证据。
- **disputed[1]（DDL 门禁对真实变异有判别力）、disputed[3]（B4 删台账条目正确）**：均为**核验记录**，
  与本节结论一致，无需动作——`disputed` 是计票口径（`alive=1`），不代表主张被推翻。
- **confirmed[0]（两表定义逐字节一致）**：核验记录，非缺陷。
- **confirmed[2]（`check:schema-ddl-drift` 的判别力盲区）**：非本批缺陷但值得长期跟踪，已按登记规则
  落 **§8.4 第 6 条**（含「重复定义」与「列序变化」两面及各自的移除条件）。

#### 四、验证

`bun test packages/resources/sandbox/src/__tests__/sandbox-source-migration.test.ts
packages/resources/workflow/src/__tests__/workflow-source-migration.test.ts` **26 pass / 0 fail**；
`env -u ANTHROPIC_MODEL bun run precheck` ✓ 全绿（15 步，7974 pass / 2 skip / 0 fail）——代码批
（`d549e0838`）与文档批各跑一次。工作树在本批开工前与收尾前均为干净状态。

**状态**：代码改动见 `d549e0838`；文档与注释订正见本批提交（§五 表「B4 审计整改」行）。

## 八、已知缺口与未完成项（逐条登记 owner 与移除条件）

> 依据 `ce-ee-engineering-standards.md` §10.7.4：边界豁免与依赖残留必须逐条登记并写明 owner
> 与移除条件。本节同时承担「阶段 2 未达 §10 全部验收标准」的缺口登记。

### 8.1 本批暴露或新引入的缺口

| # | 缺口 | owner | 移除条件 |
|---|---|---|---|
| 1 | **日志泄露**：13 处调用把 prompt 正文与 Agent 响应**截断后**打入日志（如 `acp-link/src/server.ts` 的 `text: promptText.slice(0, 200)`、`JSON.stringify(result).slice(0, 500)`）。用户裁定不做脱敏，故保留现状 | 1.8（日志规范） | 1.8 第①条落地时按「不记录完整 prompt / 未脱敏响应」收敛 |
| 2 | 根 `scripts/` 不在 tsconfig 的 `include` 内，`tsc --noEmit` 不检查它们（本批已把新增的 `db/` 纳入 globs 与 include） | 1.8（测试入口与 CI 扫描新目录） | 1.8 第②条落地时把 `scripts/` 纳入静态检查或给出等效门禁 |
| 3 | `scripts/root-source-owner-rules.ts:29` 的说明文本「apps/server data-migrate 启动迁移编排」已随 A4 过期；改动它会改变生成的 `docs/arch/root-source-owner-inventory.md` 并影响清单门禁 | 1.8（文档全量更新） | 与规则文本同批修改并重新生成清单 |
| 4 | `claude-code-runtime.ts:72` 的 `spawn("acp-link", [])` 指向不存在的可执行名（全仓无 `bin`、无全局安装；sandbox 镜像把 acp-link 当**库** bundle 进 `acp-runtime.js`）。收窄前后同样无法解析，**非本批引入** | 接入时 | 改为按 workspace 解析入口 |
| 5 | `drizzle.config.ts` 与 `apps/server/src/db/index.ts:7` 仍有本地回退连接串（含默认口令）；本批只清了两个生产入口 | 1.8（无密钥 env 模板 / preflight） | 改为必填 + 提供无密钥 env 模板后删除回退 |
| 6 | 数据迁移自身无锁/租约：release job 并行重试时两个进程可并发（完成记录表使其**大体**幂等，但 skill 文件复制不是） | §6.3 claim 状态机 | 实现 claim 状态机（§8.2） |
| 7 | 工作流节点不再继承宿主环境变量（§10.6.3 的既定方向）。依赖宿主变量的既有工作流会失效 | 已交付的行为变化 | 补偿通道：节点 `env` / `secrets` 字段显式声明 |
| 8 | `EnvDefinition` 的 `secret` / `restartRequired` 无任何消费者 | C 块 | 见 §8.4 |
| 9 | `packages/agent-runtime/src/server/services/workspace-resolver.ts:9` 直读 `process.env.WORKSPACE_ROOT`——server 装配面内**唯一**真违规 | C 块 | 见 §8.4 |
| 10 | 环境变量整段继承的残余：不传 `env` 的隐式继承 10 处、`docker/sandbox-dsh/scripts/dsh-acp-wrapper.js`、`apps/server/src/services/agent-generation.ts:63` 的 `new OpenAI()` 隐式读 `OPENAI_API_KEY` | 1.7 剩余 | 逐处改为白名单或显式注入；`new OpenAI()` 改由注入配置构造 |
| 11 | **`model-management` 没有 source-migration 契约测试**（machine / mcp / sandbox / agent-config / workflow / task 六个包均有），因此 §4.7.1 ③ 的「残留数 > 0」正向控制在 B3 无从收缩，该包与宿主的边界在测试层无人守护（只靠 `apps-boundary` 台账 + `check:dependencies`） | B 块收尾 | 按同形测试补一份（断言 `src/**` 对 `@server/**` 的残留仅 `repositories/subject-agent-search.ts:2` 一处），B7 落地后随台账清零一并改为反向断言 |

### 8.2 1.7 未完成条目（本档位不做）

migration smoke（空库 + 真实历史升级库）、`deploy-preflight`、readiness、SBOM / 备份 / 回滚与
不可逆补偿、`deploy/compose/` 与镜像构建整理、无密钥 env 模板、关键 E2E；数据迁移的
`dependsOn` 声明与拓扑排序、`verify`、`compensation`、迁移指标、claim 状态机。

### 8.3 1.8 范围（全部登记）

日志与 ALS 规范、测试迁移与 CI 目录扫描、架构 / 开发 / 运维 / README / ADR 全量更新与过期说明
移除、最终证据（含 `precheck` / `build:web` / `docs:build` 与 migration / E2E 检查）。

### 8.4 B / C 块缺口

**B 块**：

| # | 缺口 | owner | 移除条件 |
|---|---|---|---|
| 1 | 宿主 `apps/server/src/db/schema.ts` **无法清空**：D3 裁定把 `resource_permission`（+ 3 个 pgEnum）、`share_link`、`share_event_snapshot` 留在宿主，但 1.7 第五条验收口径是「宿主不再持有业务表定义」 | B 块收尾 | 三张表要么找到 owner（建议 `resource_permission` 归 access-control）并迁出，要么把验收口径改为「宿主只保留经裁定的例外」并同步权威设计 |
| 2 | ~~`machine → sandbox` 的调用期表读取（`machine-sandbox-projection.ts`）在 `sandbox_instance` 迁出后构成 §2.3 类别禁则违规~~ **已闭环（§7.13，2026-09-22）**：按 §4.8 第 3 条走「投影写路径移到 sandbox 侧」，machine 只通报事件、sandbox 在自己的表上写 | ~~B4 之前~~ 已交付 | 已验证 machine 包**生产代码**里 `sandbox_instance` 命中 0 行（全包 5 行均为注释 / 断言文本，见 §7.16）、machine 的跨模块表读取降为 1 处（`agent_config`，归 B7） |
| 3 | owner=`1.7` 的 `apps-boundary` 豁免按「该包最后一个跨模块表读取消失」逐条退场（§4.8 第 2 条）。B4 与 B6 各删 1 条（sandbox 见 §7.14、workflow 见 §7.17），**余 12 条**；其余多数要等目标表迁出后其读取点同批收口，**只能在 B 块末期集中清零** | B 块收尾 | 各目标表迁完后逐包核对「不再引用 `@server/**`」，逐条删除并留证据；`architecture:check` 的 stale 检测是充分证据 |
| 4 | 剩余 7 批（B7–B13）各有若干跨包调用期表读取需一并**改为经 owner 公开入口或宿主注入端口取数**（§4.8 第 1 条 B1 实测 19 处为 B 块**读**总数，B2 收口 1 处、B3 收口 1 处、B5 收口 1 处、B6 收口 **0 处**——该包九张表无任何跨包读取者，见 §7.17，**余 16 处**；B4 不在其中：它消除的是**跨包写**（machine 写 `sandbox_instance`），见 §7.14，2026-09-22 审计订正——本节此前把 B4 也减了一次，与「19 处是读口径」自相矛盾）；只改指 owner 的 `./db` 不算完成（§4.8 第 4 条）。**逐包清单目前无权威落点**——§4.8 #1 与本节原先的「见 §7.10」所指清单在 §7.10 中不存在，审计已指出 | 各批同批（清单并入 B 块末期，与本节第 3 条同一次扫描） | 每批交付面含全部读取点，漏改会让 preload 的模块链接期抛错（§4.8 第 1 条）、且残留 §6.1 边界 1 违规；末期逐包核对时一并产出完整清单 |
| 5 | **门禁缺口：相对路径伸进别的包 `db/` 两道门禁都不报。** `check-architecture` 的 `CROSS_PACKAGE_SOURCE_PATH`（`scripts/check-architecture.ts:43`）与 dependency-cruiser 的 `no-cross-package-src:<pkg>`（`.dependency-cruiser.cjs:28-30`）判「跨包内部路径」时只认 `src` / `web/src`，新出现的 `db/` 不在任何一侧。审计已用夹具复现（相对路径在 `db/` 与 `src/` 两种位置均 exit 0，同路径改指别包 `src/` 则 exit 1）；当前仓库无实际违规 | B 块收尾 | 把 `db` 纳入「跨包内部路径」判定，但**只对相对路径生效**——裸说明符 `@fenix/<pkg>/db` 是 §6.1 允许的组装期出口，不能一并拦 |
| 6 | **门禁缺口：`check:schema-ddl-drift` 的两处判别力盲区**（B4 主体审计发现，2026-09-22，非本批缺陷）。该门禁只做「`drizzle.config` 声明的 schema 集合 → 与最新 snapshot 的 DDL 差异」，因此：(a) **同一张表被两个已声明样式的模块重复定义**（第二份实现复活）→ 0 差异；(b) 表内**列序变化** → 0 差异（列集与类型没变）。含义是「只搬位置」的机器证据实际来自交付方**同时删掉了旧定义**这个动作，门禁本身识别不了重复定义 | B 块收尾 | 重复定义面可加一条「表名 → 定义文件」唯一性断言（前提是表名的 owner 已按 §4.7 矩阵定完，否则「同一表出现在两个 owner 的 schema 里」与「宿主 barrel 转出」需要区分）；列序面若重要，可对 snapshot 做「逐列序号」比较。两者都要另开任务，不在 1.7 内实现 |
| 6 | 组装期 `db/` 不在「子进程不得整段继承宿主 env」的扫描面内：`scripts/check-dependency-boundaries.ts:54-72` 的文件收集只认目录名 `src`，`packages/*/db/**`（含设计规定的 `db/data-migrations/`）整体跳过。审计判定为**已声明范围**而非漏报（该步骤注释即写明范围只含 `packages/**/src/**`；`db/` 是组装期 + 幂等 DML 层，不构造子进程；实测 db/ 下 2 个文件零 `process.env` / spawn） | 不修，登记备查 | 若日后 `db/data-migrations/` 出现子进程调用，须同步扩大扫描面 |
| 7 | **B7 前置：`agent-runtime` 在查询期 LEFT JOIN `agent_config`**（`services/environment-orchestration.ts`、`services/environment-web.ts`）。`agent_config` 迁出后该导入命中 `.dependency-cruiser.cjs:74-90` 的 `agent-runtime-not-to-resources`（其 `pathNot` 只排除 `packages/agent-runtime/db/` 与 `packages/resources/(machine\|sandbox)/`），而 `check-architecture` 拦不住它。按 §4.8 第 4 条应改为经 agent-config 公开入口取投影（若 `agent-runtime → agent-config` 的包级边不被装配方向允许，则退回宿主注入端口），但 LEFT JOIN → 批量投影查询是一次独立设计（且要避免 N+1） | B7 之前 | 先反馈再定夺取数形状，然后重构两个查询 |
| 8 | **D4 裁定（3 张 join 表归 agent-config）与现有实现冲突。** `agent_config_mcp` 已由 mcp 包自持（`mcp/src/server/services/config/agent-config-mcp.ts`，文件头自述「MCP 包自持」），`agent_config_skill` 同理由 skill 包持有，唯一的读者是各自包内文件。按 D4 迁到 agent-config 会让 mcp / skill 反向导入 `@fenix/agent-config/db`：两者都未声明该包（触发 `undeclared-workspace-dependency`），且 `agent-config → mcp`（7 处）、`agent-config → skill`（9 处）已存在，各自闭合一条**新环**。这是 D4 裁定当时未计入的成本。**B2 实测佐证**（§7.11）：mcp 包的 `agent_config_mcp` 读写口径已由该包自己的 `./server/config` 出口公开，且 B2 迁表后它是该包**唯一**残留的宿主表读取——按 D4 迁走会让这个出口失去唯一内容 | B7 之前 | 重新确认：维持 D4（mcp / skill 改写为经 agent-config 公开 service 访问）还是改为按现有实现归属（各持自己的关联表，agent-config 经它们的窄入口访问） |

**C 块**：C1 的已知破测（`workspace-resolver.test.ts` 4 条、machine 侧 10 个文件因
`initializeMachineModuleConfig` 只注册 `"machine"` 而抛「模块 agent-runtime 未声明应用基础设施配置」）
尚未处理；宿主 env schema 缺 `GOTENBERG_URL` / `RCS_WORKFLOW_HMAC_SECRET` 两键（C2 补）。

### 8.5 边界豁免与依赖残留（§10.7.4）

台账 `scripts/architecture/exceptions.json` 共 28 条（B4 删除 sandbox 的 `apps-boundary` 条目后，见 §7.14）：

- **13 条 owner=`1.7`**：均为 `apps-boundary → @fenix/server-app`，属 B 块范围，随宿主收敛清理。
- **15 条 owner=`未排期`**：10 条 `no-circular`（跨包环的「每环一条」代表边）+ 5 条
  `undeclared-workspace-dependency`（`acp-link` 系缺依赖声明）。按台账 `_comment` 的口径，这
  15 条是「门禁修复后被如实暴露出来的既有债务，不属于任何在排任务的范围」。本批不动，按 §10.7.4
  在此登记：**建议在阶段 2 收口时统一排期，或明确写入「接受为长期例外」的理由**，不留在
  「未排期」这一无归属状态。
