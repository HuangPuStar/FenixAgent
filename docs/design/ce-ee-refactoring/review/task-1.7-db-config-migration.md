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
   **已结案（两处均按此收敛）**：machine→`agent_config` 的写改经 `bindMachineIdByAgentName`（B7，见 §7.19）；
   agent-config→`environment` 的写改经 owner 的 `deleteEnvironmentsByAgentConfig(tx, {...})`——**事务句柄由
   调用方传入**，保留「删环境 + 删配置」同事务语义（B8，见 §7.20）。

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
| B7 前置 | agent-runtime 的 `agent_config` LEFT JOIN 改为经 owner 公开入口取投影，装配方向不允许时退回宿主注入端口（§4.8 第 4 条 / §8.4 第 7 条） | 已交付 | 见 §7.19 |
| B7 前置 | join 表归属与 D4 的冲突复核（§8.4 第 8 条） | 已交付（裁定：三张 join 表全归 agent-config） | 见 §7.19 |
| B6 | workflow（九张领域表）迁至 `@fenix/resource-workflow/db` | 已交付 | 见 §7.17 |
| B7 | agent-config（`agent_config` + 三张 join 表 + `agent_site_app`）迁至 `@fenix/agent-config/db`；machine / model-management / observer 的调用期读取与写入收口 | 已交付 | 见 §7.19 |
| B8 | agent-runtime（`environment`、`agent_instance`）迁至 `@fenix/agent-runtime/db`；agent-config 的跨包读 / 写改经 owner 公开入口（事务句柄由调用方传入） | 已交付 | 见 §7.20 |
| B9 | knowledge（`knowledge_base`、`knowledge_resource`、`agent_knowledge_binding`）迁至 `@fenix/resource-knowledge/db`；agent-config 的跨包读改经 owner 新增的只读投影出口 | 已交付 | 见 §7.21 |
| B10 | memory（`agent_memory_config`）迁至 `@fenix/resource-memory/db`；跨包读取点收口 0 处（记忆开关早已只经本包 `./server` 公开出口） | 已交付 | 见 §7.22 |
| B11 | prod-view（`prod_view`）迁至 `@fenix/resource-prod-view/db`；跨包读取点收口 0 处（全仓无第二个读取者），契约测试白名单改零例外 | 已交付 | 见 §7.23 |
| B12 | task（`scheduled_task_v2`、`task_execution_log`）迁至 `@fenix/resource-task/db`；跨包读取点收口 0 处（宿主无读写方，唯一包外读取是宿主测试的列名断言，就地改指 owner 出口），契约测试白名单改零例外 | 已交付 | 见 §7.24 |
| B13 | 其余 3 张表按拓扑序迁出（§4.7 表共 36 张，B1–B12 已迁 33 张；§4.7.1 交付面） | 待办 | — |
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

### 7.19 B7：`agent_config` 一族 5 张表迁至 `@fenix/agent-config/db`（2026-09-22，本批）

**交付面**：新 owner 文件 `packages/resources/agent-config/db/schema.ts`（主表 `agent_config`、三张 join 表
`agent_config_skill` / `agent_config_mcp` / `agent_config_site_app`、Agent Sites 代理表 `agent_site_app`）；
`package.json` 加 `./db` 出口并补 `@fenix/identity` 依赖声明；`drizzle.config.ts` 加该 schema 路径；本包
`src/server/**` 10 个生产文件经该出口取表（其中 `repositories/agent-config-mcp.ts` /
`agent-config-skill.ts` 为新增），另有 2 个用例文件（`agent-config-schema.test.ts` 新增、
`round45-agent-config-routes-coverage.test.ts` 改指）；宿主 `schema.ts` 删五张
表定义（`git diff --numstat` → 删 147 / 增 19，净 -128），改为导入该出口供 5 处**自有表**外键表达，另有
`services/data-migrates/` 两个发布期迁移按
§4.7.1 第 1 条的宿主 carve-out 经同一出口取表对象；调用期跨包读 / 写收口（见下）；`scripts/architecture/exceptions.json` 删 5 条、
更新 2 条；mcp / skill / machine / model-management / observer 的契约测试与注释同步。

**调用期收口明细**（§4.7.1 第 1 / 4 条。B7 是 B 块唯一**同时**含读收口与写收口的批次）：

| 包 | 迁移前的形态 | 收口后 |
|---|---|---|
| `agent-runtime` | `services/environment-orchestration.ts`、`services/environment-web.ts` 查询期 LEFT JOIN `agent_config` | 宿主注入的 `AgentConfigLookupPort` 新增 `findAgentConfigExecutionFields` / `findAgentConfigNamesByIds` 两个只读投影方法，LEFT JOIN 变批量投影 |
| `machine` | `registry.ts` 删除守卫读 `agent_config`（存在性判定）+ 机器注册路径 UPDATE `machine_id` | 读改经 `isAgentConfigBoundToMachine`、写改经 `bindMachineIdByAgentName`（`@fenix/agent-config/server`） |
| `model-management` | `repositories/subject-agent-search.ts` 自持主体检索 SQL | 薄适配层：只做 `page` / `pageSize` → `limit` / `offset` 换算，检索归 `searchAgentConfigsSystem` |
| `observer` | `repositories/system-people-repository.ts` 自持归属查询 | 改经 `listAgentConfigsByOrganization`，行类型用 owner 的 `AgentConfigOwnershipRow` |
| `mcp` / `skill` | 各自持有并读写自己的关联表 | 表与读写随聚合根归 `agent-config`，两包旧文件删除，`./server/config` 收缩为纯标签投影 |

三处需要记下理由的取舍：

- **端口新增两个方法而不是复用既有的**：`findAgentConfig` / `findVisibleAgentConfig` 返回整行且带可见性
  （授权）语义；编排仓储要的是「原始执行字段」与「按 id 取名称」，复用会把授权语义带进执行期路径。
  端口在配置行已被删除时返回 `null`，调用方按迁移前 LEFT JOIN 的语义降级（字段缺失 → fallback 默认
  机器），该分支由 `environment-orchestration.test.ts` 新增用例钉住（同时断言端口确实被以
  `agentConfigId` 调用过，避免「降级正确但根本没查」也判绿）。
- **宿主零文本改动**：接口扩展只落在 agent-runtime 的端口定义与 agent-config 的实现
  （`services/agent-config-lookup.ts`）上，`bootstrap/host-startup.ts` 与 `services/pre-launch-ports.ts`
  均未改动（实现对象原地满足扩展后的契约）。
- **machine 的守卫与写入走 owner 的公开 service、不是端口**：`agent-config → machine` 已存在（B1 的
  `MachineLookupPort` 方向），反向声明会闭合新环；而 `machine → agent-config` 是既有边，直接用公开入口
  不新增任何包级边。抛错文案（`machine '<id>' is still referenced by agent configs`）与 `tenantId` 为空
  时跳过写入的行为逐字保留。

**为什么 D4 成立、而 B2 / B5 的实现必须改**（§8.4 第 8 条结案，用户裁定「全归 agent-config」）：三张 join
表的 `agent_config_id` 指向聚合根，Drizzle 的 `.references()` 只接受列对象、没有字符串形式，因此任何
**非本包持有**的 join 表都必须组装期导入 `@fenix/agent-config/db`。若留在 mcp / skill，反向的
`mcp → agent-config` / `skill → agent-config` 既未声明（`undeclared-workspace-dependency`），又会与既有
`agent-config → mcp`（7 处）/ `agent-config → skill`（9 处）闭合新环。B2 / B5 期间的「各包自持」是迁移
中间态，其文件头自述的理由是「避免第二个包再写一份 delete + insert 覆盖逻辑」——而这张表的唯一读者本来
就在 agent-config 侧（`services/agent-associations.ts`），随表迁入没有第二处调用方，该理由随之消失。

**两处 `sync*` 的空串过滤实现不一致（逐字迁移，登记而不顺手改）**：`syncAgentMcps` 用
`mcpServerIds.filter((id) => id?.trim())`，**保留未 trim 的原值**入库；`syncAgentSkills` 用
`skillIds.map((id) => id?.trim()).filter(Boolean)`，**先 trim 再入库**。两者都随各自原文件逐字迁入本包
（迁移前即如此，`git show HEAD:` 可复核），**不是本批引入的行为差异**。统一它会改变其中一条写入路径的
落库值（带前后空白的 id 从「原样」变为「已 trim」），属行为变更，故按「只搬位置」的原则登记：
**建议与「关联表写入是否需要 id 格式校验」一并排期**，不要在迁移批里顺手改。

**被删断言在 owner 侧接回（不留覆盖缺口）**：machine 的 `registry-schema.test.ts` 删除了「`agent_config`
包含 `machineId` 列」（原经 `@server/db/schema` 断言）；按 B1 对 `machine.type` 的同一口径——B1 审计把
「删断言无人接回」判为缺陷——本批在 owner 侧新增
`packages/resources/agent-config/src/__tests__/agent-config-schema.test.ts` 接回五张表的列存在性断言。
列名映射（属性名 → DB 列名）仍由 `bun run check:schema-ddl-drift` 承担。

**合约测试正向控制的口径更换（两处，均为「消失的载体」而非「放宽断言」）**：

- `mcp-source-migration.test.ts` 原以「`@server/db/schema` 残留数 > 0」作正向控制；本批残留归零后改为
  「存在 `@fenix/platform-sdk` 说明符且存在相对导入」，并把宿主断言改为 `@server/` 前缀为空。
- `skill-browser-surface.test.ts` 的负例注入原断言「注入 `./server` 后图里出现 `@server/*`」；本包零宿主
  导入后该标记不再可用，改用服务端专属外部依赖 `elysia` / `drizzle-orm`（与 `node:` 内建两条并存，
  「进到了服务端实现」与「拦截能力」缺一不可）。同包 `skill-source-boundary.test.ts` 的宿主引用断言由
  「等于白名单」升级为「等于空数组」，白名单常量删除。

**台账**：删 5 条 `apps-boundary`（machine / model-management / mcp / skill / observer），依据是五包
`src/**` 与 `db/**` 的 `@server` 实测归零 + `architecture:check` 的 stale 检测；`agent-runtime` 与
`agent-config` 两条保留并追加「§1.7 B7 进度」段——两者残留都指向尚未迁出的**宿主自有**表
（`environment` / `agent_instance` / `knowledge_base`），随 B8 / B9 收口。

**验证**：`check:schema-ddl-drift` 零差异（五张表只搬位置）；`architecture:check` 通过（2134 files，10
rules，12 条已登记例外）；`check:dependencies` 通过（2276 modules，10 条已登记例外，0 条新增违规——D4
裁定下没有新增任何包级边）；`tsc --noEmit` 无错误；包内测试 agent-config 731 / machine 551 / mcp 289 /
skill 276 / model-management 233 各自单跑全绿；observer 与宿主 `bun run precheck` 的实测见本批收尾段。

**已知缺口登记**（新增，与本节 8.4 第 6 条的 DDL 门禁盲区同族）：`agent_config` 的**列结构**断言已在
owner 侧接回，但「表名 → 定义文件」唯一性仍无门禁——若这五张表日后在宿主或其他包重新出现第二份定义，
`check:schema-ddl-drift` 会因「差异为零」而放行。移出条件同 §8.4 第 6 条第 (a) 项（表名 owner 定完后加
唯一性断言）。

**observer 侧收口（代理执行、我逐条复核）**：删 `src/server/db.ts`、`src/server/repositories/system-people-repository.ts`
与其用例（并清掉空目录）；`services/system-people-tree-service.ts` 改经 `@fenix/agent-config/server` 的
`listAgentConfigsByOrganization()` 取数，并在边界处转成视图类型（`toSystemPeopleAgent(row: AgentConfigOwnershipRow)`）；
`__tests__/system-people-db-stub.ts` 改用 owner 的行类型、删掉 `collectColumnNames`、把 `collectParamValues`
降为私有（它已只服务替身自己的组织反查）；`observer-package-contract.test.ts` 去掉宿主导入白名单、改以
`@fenix/platform-sdk` 与非相对导入作正向控制，`DATA_ACCESS_DIRS` 收敛为空集。**空集不等于空转**：读源码确认该
断言扫 `filesUnder("src")` 的全部文件、只跳过白名单，命中任何 `getObserverDatabase` / `getDatabase` /
`@server/db` 说明符都会失败。实测 observer 单跑 **78 pass / 0 fail**。

**文档与注释同步（代理执行、我逐条复核）**：6 个 README（agent-config / machine / mcp / model-management /
observer / skill）+ 6 个 `fenix.module.ts` 注释 + `skill/db/schema.ts` 的 JSDoc。复核不只看它的引述，而是
独立复算关键数字：6 个 `fenix.module.ts` 的 diff **非注释行 = 0**（`dependsOn` 未改）；agent-config 的生产
宿主导入 2 处（`environment` / `knowledge_base`）；五张表的 `.references()` 跨包目标 5 个（`user` /
`model` / `machine` / `mcpServer` / `skill`）；`@fenix/identity` 是 `package.json` 唯一新增依赖；agent-runtime
的宿主表导入只剩 `environment` / `agent_instance`；宿主 `schema.ts` 里 `agentConfig` 5 个使用点；台账里
machine 名下 2 条 `no-circular`、observer / mcp / skill / model-management 条目为 0。**代理范围外的两处失实我
自己补**：`agent-config/src/server/db.ts` 的句柄注释（它被明确禁止改该目录）与本节交付面的两个数字
（本包文件数、宿主 `schema.ts` 的删行数与使用点数——`git diff --numstat` 实测删 147 / 增 19）。其判定
「stale 但不改」的 5 项我抽查后同意，其中 `skill/src/server.ts` 的「agent-runtime 是合法消费者」在 B7 前后
一致（`git grep '@fenix/resource-skill' HEAD -- packages/agent-runtime` 也只命中 `package.json` 一行），
属契约许可陈述而非本批失实。

**precheck 实测**：`env -u ANTHROPIC_MODEL bun run precheck` → **15 步全绿**（122.9s）：format / import-sort /
module-registry / web-contributions / owner-inventory / schema-ddl-drift / architecture / tsc（server、web、
app skeletons）/ dependency-boundaries / lint / server-and-script-tests（806 pass）/ package-tests（7991 tests：
7988 pass / 2 skip / 0 fail）/ web-app-tests（319 pass）。首跑有一次**与本批无关**的抖动失败：
`workflow-engine/src/__tests__/executor/api-executor.test.ts` 的 `expect(elapsed).toBeLessThan(3000)` 实测
5224ms——该包本批零改动（`git status --porcelain | grep workflow` 为空），隔离单跑同文件 20 pass、整文件
1376ms，判定为 639 文件并发下的计时抖动；复跑全绿，未改该断言。与 §7.10（`bun test packages/`）与 §7.11
（`round37-service-boundaries`）记录的两条属同一类——负载下的时序敏感用例，本档不另建清单，按上述三段各自的
「非确定性失败记录」就地登记。

### 7.20 B8：`environment` / `agent_instance` 迁至 `@fenix/agent-runtime/db`（2026-09-22，本批）

**交付面**：新 owner 文件 `packages/agent-runtime/db/schema.ts`（运行环境 `environment`、持久实例
`agent_instance`、pgEnum `agent_instance_creation_source`，DDL 与列序逐字保留）；`package.json` 加 `./db`
出口并补 `@fenix/identity` 依赖声明（`@fenix/agent-config` 此前已在——`environment.agent_config_id` 是该
owner 包的跨包外键目标）；`drizzle.config.ts` 加该 schema 路径；包内 **6 个文件**改指本包出口（5 个生产：
`src/server/repositories/{agent-instance,environment,environment-orchestration}.ts`、
`src/server/services/environment-web.ts`、`src/services/agent-chat-service.ts`；1 个用例：
`src/__tests__/environment-max-sessions-migration.test.ts`）；宿主 `schema.ts` 删两张表定义、两个类型导出
行与那个 pgEnum（`git diff --numstat` → 增 13 / 删 82），改为导入该出口供**唯一的**自有表外键
`im_channel_route.environment_id` 表达，同时删掉随两表带走的 `check` 导入（宿主 schema 不再使用它）；
调用期跨包写收口（见下，§4.8 第 7 条结案）；`scripts/architecture/exceptions.json` 更新 2 条（无删无增）；
两份 README（agent-runtime 新增「表定义与边界残留」节、agent-config 改 2 处补 1 处）与
`agent-config-source-migration.test.ts` 的豁免口径注释同步；新增 owner 侧用例
`packages/agent-runtime/src/__tests__/environment-agent-config-entries.test.ts`（4 条）。

**调用期收口明细**（§4.7.1 第 1 / 4 条）：

| 消费方 | 迁移前的形态 | 收口后 |
|---|---|---|
| `agent-config`（读） | `agent-config-resource.ts` 的 `listBoundEnvironmentIds` 直读 `environment` 取 id | `@fenix/agent-runtime/server/environment` 的 `listEnvironmentIdsByAgentConfig`（只取 id，无授权判定——调用方 Facade 已判 `delete` / `use`） |
| `agent-config`（写） | `removeWithEnvironments` 在同一事务里 `tx.delete(environment)` + `tx.delete(agentConfig)` | 同出口的 `deleteEnvironmentsByAgentConfig(tx, {...})`，**本包的事务句柄传进 owner**，仍是同一个事务 |

**跨包写为什么用「owner 入口收 tx」**（用户裁定，2026-09-21）：标准 §82 行的口径是「跨资源事务由
`apps/server` 的 use case / orchestration 组合」，§329 行同时允许「事务经函数参数、包公开 API 或 app 装配
传递」；三条候选（owner 入口收 tx / 宿主 use case 组合 / 非事务两步）里选第一条，理由是：
① 「配置已删、环境还在」与「环境已删、配置还在」都是可见中间态（界面残留无主环境 / workspace 路径与
`secret` 已丢而 Agent 仍存在），两步非事务被排除；② 宿主 use case 组合要把删除逻辑从 Repository 上提到宿主，
等于把 agent-config 的编排切开两处；③ 句柄类型天然兼容——各包 `db.ts` 的句柄**刻意不写 `typeof schema`**
（见 `packages/agent-runtime/src/server/db.ts` 的注释，该决定早于本次迁移），两个包因此都是
`NodePgDatabase<Record<string, never>>`，跨包传 tx 无需共享自定义类型；identity 已有「把事务回调参数标注为
包句柄类型」的先例（`packages/platform/identity/src/services/ensure-system-admin.ts:110`）。改动面因此只有
一处调用点与一个新增入口，与 B7 的「owner 公开入口」口径一致。

**两条入口的边界**（都写进了 JSDoc 与用例）：

- **不重复授权**：两个入口都不做组织 / 可见性判定，调用方 Facade 已完成；与迁移前 agent-config 直读表对象
  同口径。
- **归属条件双列下推**：`organization_id` 与 `agent_config_id` 同时进 WHERE。`agent_config.id` 是全局 uuid，
  单列条件不会误伤别的配置；双列的实际作用是「调用方把组织与配置配错时退化成空操作」，而不是跨组织写。
  这层语义由新增用例钉住（列名 + 绑定值都对调用方入参做等式断言，避免把 `organizationId` 写死成常量也判绿）。
- **删除顺序仍归调用方**：owner 只删环境行，`agent_instance` 经 `environment_id` 的 `onDelete: "cascade"`
  随之清理；顺序约束（environment → agent_config）仍由 agent-config 的 `removeWithEnvironments` 持有，
  原用例 `agent-config-delete.test.ts` 未改断言，只把 `environment` 的对象来源改指
  `@fenix/agent-runtime/db`（同一模块实例，对象同一性不变，因此 `table === environment` 的判别仍然成立）。

**变异实验（用例判别力自证）**：把 `deleteEnvironmentsByAgentConfig` 改成
`getAgentRuntimeDatabase().delete(environment).where(eq(environment.agentConfigId, ...))`（即同时踩「绕开传入
句柄、自己取模块句柄」与「丢掉组织条件」两点），4 条用例中 2 条当场失败——一条报出替身预设的
「删除入口必须使用调用方传入的句柄」，另一条报出基础设施未初始化（即确实没走传入句柄）；还原后复跑
4 pass，`git diff` 复核只剩预期改动。

**宿主 `schema.ts` 仍导入 `environment`（至 B13）**：`im_channel_route.environment_id` 需要该表对象表达外键，
Drizzle 的 `.references()` 只接受列对象、没有字符串形式；`im_channel_route` 属 B13（channel）批次，届时宿主这
一行 import 也随之删除。文件头注释已按此改写，并逐条更正 `agentConfig` 的四个使用点（
`agent_knowledge_binding` / `task_execution_log` / `agent_memory_config` / `prod_view`，随 B9–B12 迁出）。

**台账**：2 条 `apps-boundary` 更新、0 条删除。

- `@fenix/agent-runtime → @fenix/server-app`：**生产侧归零、条目未失效**。原先 5 处 `@server/db/schema`
  随两张表迁出全部消失（实测 `grep -rnE 'from "@server/' packages/agent-runtime/src
  packages/agent-runtime/web packages/agent-runtime/fenix.module.ts | grep -v __tests__` → 0 条 / 0 文件），
  但测试侧仍有 17 处 / 17 文件（`module-stubs` 16 + `error-handler` 1，比 1.5g 复测少 1 处——本批把
  `environment-max-sessions-migration.test.ts` 改指本包出口）。`removeWhen` 因此**改写为「测试侧归零」**，
  不再挂 §1.7 的表定义迁出——这正是 §4.8 第 2 条立的口径（删除时机是「该包最后一个跨模块表读取消失」，
  不是「该包自己的表迁完」），本批是它的第二次印证。
- `@fenix/agent-config → @fenix/server-app`：由 4 处（生产 2 + 测试 2）降为 **2 处**（生产 1 + 测试 1），
  两处都取 `knowledge_base`，随 B9 迁出后本条归零。

**契约测试口径**：`agent-config-source-migration.test.ts` 的 `ALLOWED_HOST_IMPORT` 说明与正向控制注释改为
**只剩 `knowledge_base`**。正向控制仍然成立（`knowledge_base` 的导入必然存在），因此没有出现 B1 / B7 那种
「正向控制载体消失、必须换控制物」的情况——这也是本批唯一不需要改断言的契约测试。

**验证**：`check:schema-ddl-drift` 零差异（两张表只搬位置）；`architecture:check` 通过（2135 files，10 rules，
12 条已登记例外）；`check:dependencies` 通过（2278 modules，10 条已登记例外，0 条新增违规——`agent-config →
agent-runtime` 是 §2.3 登记的合法方向，且该边此前已由 `./runtime` 与 `./server/environment` 消费，本批未新增
任何包级边，也未新增环指纹）；`generate:module-registry --check` 通过（17 个 manifest 已验证）；
`tsc --noEmit` 无错误；新增用例 4 pass / `agent-config-delete.test.ts` 1 pass；宿主 `schema.ts` 删行后
`@server/db/schema` 不再导出这两张表，全仓实测无残留引用（D1 的 `db/**` 例外下，其它包也没有第二处取用）。

**precheck 实测**：`env -u ANTHROPIC_MODEL bun run precheck` → **15 步全绿**（86.5s）：format / import-sort /
module-registry（17 个 manifest）/ web-contributions / owner-inventory / schema-ddl-drift / architecture /
tsc（server、web、app skeletons）/ dependency-boundaries / lint / server-and-script-tests（806 pass / 0 fail，
65 files）/ package-tests（7995 tests：**7993 pass / 2 skip / 0 fail**，640 files）/ web-app-tests（319 pass /
0 fail）。本批**首跑即全绿、无抖动**，无需重复记录；与 §7.19 相比 package-tests 的 `Ran` 数 +4，正是本批新增的
4 条 owner 侧用例（`environment-agent-config-entries.test.ts`），用例总数的变动口径与改动面一致。

**未新增缺口**：本批没有引入新的门禁盲区或既有缺陷，§8.4 第 7 条（跨包写收敛）在此结案，§8.4 第 3 / 4 条
的计数按本批事实改写。

### 7.21 B9：`knowledge_base` / `knowledge_resource` / `agent_knowledge_binding` 迁至 `@fenix/resource-knowledge/db`（2026-09-22，本批）

**表与依赖**：三张表的 DDL 逐字搬入新建的 `packages/resources/knowledge/db/schema.ts`。跨包外键目标两条：
`user`（`@fenix/identity/db`，1 次）与 `agentConfig`（`@fenix/agent-config/db`，1 次，
`agent_knowledge_binding.agent_config_id`）。`package.json` 因此新增 `@fenix/agent-config` 与
`@fenix/identity` 两个 workspace 依赖；**`dependsOn` 保持 `[]`**——装配校验（`assertDependsOnComplete`）
只扫 `src/**`，且表定义表达的是「列对象来自谁的迁移链」而不是运行期耦合（同口径：`agent-config` 的
`dependsOn` 也未列 `machine` / `model-management`，尽管其 `db/schema.ts` 取了两者的列对象）。manifest 注释
已补这一段，避免后来者把「表定义跨包导入」误读成漏声明。

**调用期读取点收口（1 处）**：`@fenix/resource-agent-config` 的 `services/agent-related-resources.ts` 原先
直读宿主 `@server/db/schema` 的 `knowledge_base` 做知识库绑定投影，改经本包**新增的公开出口**
`@fenix/resource-knowledge/server/summaries` 的 `findKnowledgeBaseSummariesByIds`。该文件头注释现并列三条
owner 公开入口（mcp `./server/config`、skill `./server/config`、knowledge `./server/summaries`），本模块因此
**不再导入任何宿主表对象**，`getAgentConfigDatabase()` 只剩自己的 `agent_site_app` 一条查询在用它。
`round45-agent-config-routes-coverage.test.ts` 的替身按**表对象身份**分派，故只把 `knowledgeBase` 的来源改指
`@fenix/resource-knowledge/db`（同一模块实例，判别与断言全不变）。

**出口命名的一处刻意不同**：knowledge 的新出口键是 `./server/summaries`，没有沿用 mcp / skill 的
`./server/config`——本包已有 `src/server/config.ts`（模块配置 `KnowledgeModuleConfig`，未导出），而键名是
公开契约、事后改名要动消费方。出口内容是薄文件 `src/server/knowledge-summaries.ts`（唯一内容即 re-export，
理由写在文件头）。

**投影语义的两处刻意差异**（与同族 mcp / skill 投影相比，写进 JSDoc）：① 多一个 `organizationId` 条件——
`knowledge_base` 没有 `visibility` 列，归属就是 `organization_id`；配错组织退化为「用 ID 当标签」，而不是把
别组织的名称泄露出去（skill / mcp 的投影只按 id 取、不做归属判断）；② 多返回 `slug`（消费方视图需要）。

**宿主 `schema.ts`**：删 75 行三表定义（377 → 302 行）。宿主对这三张表本就只有定义、没有任何引用方
（宿主 `db-schema.test.ts` 用自写的 SQLite DDL，不取 Drizzle 表对象），因此该文件**连一个 `import` 都不留**——
这是 B 块第一个「迁出后宿主零 import 残留」的批次。头部注释同步改写（`agentConfig` 的三个使用点、
`environment` 只剩 `im_channel_route` 一处、三张表「从未出现在外键清单里」）。`drizzle.config.ts` 的 schema
数组插入本包路径。

**台账删 2 条**：`apps-boundary @fenix/agent-config → @fenix/server-app`（B8 后 2 处、均取 `knowledge_base`）
与 `apps-boundary @fenix/resource-knowledge → @fenix/server-app`（1 处）随本批双双归零 → 两条都删。
实测 `architecture:check` → 10 条已登记例外（原 12 = 7 + 5 → 5 + 5）；`check:dependencies` →
**2281 modules**（B8 基线 2278，+3 = 新 schema 文件、薄出口、新用例）/ 10 条已登记例外 / **0 条新增违规**。
开批前已实测确认新增边 `knowledge/db → agent-config/db` **不闭合任何回路**：`no-circular` 是文件级判定且
`.dependency-cruiser.cjs` 对它没有 `db/` 的 `pathNot` 豁免，但 `agent-config/db/schema.ts` 只导入
identity / model-management / machine / mcp / skill 的表对象（是「汇」不是「源」），无法经它折回 knowledge；
直接跑 dependency-cruiser 得到的 54 处文件级环按包对归一后全部落在已登记的 10 条 `no-circular` 例外内。

**契约测试收缩（§4.7.1 ③ 的第三种形态：载体消失 + 零容忍）**：`agent-config-source-migration.test.ts` 的
正向控制载体（`knowledge_base`）随本批消失，按 §7.14 B4 定型的「零容忍 + 负例夹具」三件套收缩——删除
`ALLOWED_HOST_IMPORT` 常量与随之无用的注释；判据由「等于该精确路径的其余一概违规」收缩为
「**不以 `@server/` 开头**」（测试名改为「包内不存在任何宿主 `@server` 导入」）；新增 `SCANNER_FIXTURE`
负例夹具承担原正向控制职责（块注释形状，两半断言：未剥注释时块注释里的形似导入必须被捞出、剥掉后只剩
真实导入）。另比照黄金样本 B4 主体审计的整改，把 `db/schema.ts` 加进自检清单——收缩之后「本包确实零宿主
导入」与「`db/` 根本没进扫描集」必须分得开。knowledge 包**不新建**同款契约测试：它从未有过该测试，残留
归零后由 `apps-boundary` 门禁（未登记的新违规即失败）守护，符合「能不做的先不做」。

**本该失败却先失败的第二处（web 面守卫，实测发现）**：`knowledge/web/__tests__/knowledge-browser-surface.test.ts`
的负例「注入真实的 `./server` 出口时递归进入服务端实现并触发拦截」中有一半断言「服务端必然出现
`@server/*` 说明符」，本批归零后该载体消失、用例转红。处置：删掉这半条，改由「递归到底层仓储文件
（`src/server/repositories/knowledge-base.ts`）」+「`node:` 内建确实发自 `src/server/**` 内部」承担「递归深度
足够」这一职责，注释写明它当初证明的是什么。这不是「让红变绿」，而是同一条 §4.7.1 ③ 收缩在 web 面守卫上的
第二次应用——**收缩载体消失的断言时，必须用同强度的证据替换它，而不是直接删**。

**新增 owner 侧用例**：`src/__tests__/knowledge-base-summaries.test.ts` 3 条——空 ID 集合短路且不查库、
投影三列与「组织 + id 集合」条件的编译后 SQL 参数、结果以 id 为键且只带展示字段（未命中的 id 不在 Map 里，
消费方据此退化成 ID 标签）。SQL 断言经 `PgDialect.sqlToQuery` 取 `sql` + `params`，与
`sandbox-instance-machine-projection.test.ts` 同法。

**验证**：`check:schema-ddl-drift` 零差异（三张表只搬位置）；`architecture:check` 通过（2139 files，10 rules，
10 条已登记例外）；`check:dependencies` 通过（2281 modules，10 条已登记例外，0 条新增违规）；
`generate:module-registry --check` 通过（17 个 manifest，新增的两个 exports 键不影响清单）；
`tsc -p apps/server/tsconfig.json` / `apps/web/tsconfig.json --noEmit` 均无错误；新增用例 3 pass / 0 fail；
`knowledge` 的浏览器面守卫 16 pass / 0 fail。

**precheck 实测**：`env -u ANTHROPIC_MODEL bun run precheck` → **15 步全绿**（83.955s，首跑即绿、无抖动）：
format / import-sort / module-registry（17 个 manifest）/ web-contributions / owner-inventory /
schema-ddl-drift / architecture / tsc（server、web、app skeletons）/ dependency-boundaries / lint /
server-and-script-tests（806 pass / 0 fail，65 files）/ package-tests（7998 tests：**7996 pass / 2 skip /
0 fail**，641 files）/ web-app-tests（319 pass / 0 fail）。与 §7.20 相比 package-tests 的 `Ran` 数 +3、文件数
+1，正是本批新增的 3 条 owner 侧用例（`knowledge-base-summaries.test.ts`），用例总数的变动口径与改动面一致。

**未新增缺口**：本批没有引入新的门禁盲区或既有缺陷；§8.4 第 3 条（余 5 条豁免）与第 4 条（收口计数）
按本批事实改写。

### 7.22 B10：`agent_memory_config` 迁至 `@fenix/resource-memory/db`（2026-09-22，本批）

**表与依赖**：单表，DDL 逐字搬入新建的 `packages/resources/memory/db/schema.ts`（列名、默认值、
`.unique()` 约束一字未动，位置搬迁由 `check:schema-ddl-drift` 实测零差异）。跨包外键目标一条：
`agentConfig`（`@fenix/agent-config/db`，`agent_memory_config.agent_config_id`）。`package.json` 因此新增
`./db` 出口与 `@fenix/agent-config` 的 workspace 依赖；**`dependsOn` 保持 `[]`**——装配校验只扫 `src/**`，
表定义表达的是「列对象来自谁的迁移链」而不是运行期耦合（口径与 B9 的 knowledge 完全同形，manifest 注释已补
这一段并列出 agent-config / knowledge 两个同口径先例）。表头注释按单表 owner schema 的既有样式写：迁移链
历史 DDL 原样保留、`check:schema-ddl-drift` 门禁、跨包外键目标逐条说明、§6.1 组装期例外口径。

**调用期读取点收口：0 处**（与 B6 同形）。记忆开关的**跨包**读写从一开始就只有一条路径——消费方
`@fenix/agent-config` 的 `services/agent-associations.ts` 与 `services/agent-launch-spec/memory-env.ts` 走的是
本包 `./server` 出口的 `isAgentMemoryEnabled` / `setEnabled`，本批无需改指；宿主侧则**没有任何**读取点
（实测 `command grep -rn "agent_memory_config\|agentMemoryConfig" apps packages scripts` 的命中只有表定义、
本包仓储与注释）。语义上的唯一数据访问点在本包里，它自己的表迁出只换 import 来源，不换消费路径。

**表定义的自引用写法**：仓储的 import 从 `@server/db/schema` 改为 `@fenix/resource-memory/db`（**包名自引用**
而不是相对路径 `../../db/schema`）：`db/` 不在包 `tsconfig.json` 的 `include` 里，只有走包 `exports` 才能被
解析，这也让「包内取表对象」与「跨包消费方取表对象」是同一个解析口径（`@fenix/agent-config` 同形）。

**宿主 `schema.ts`**：删表定义与注释共 12 行（302 → 296 行）。宿主对这张表的唯一引用方是 memory 包的仓储
（已改指该出口），因此本文件**连 import 也不必新增**——与 B9 的 knowledge 同为「迁出后宿主零 import 残留」的
形态。头部注释同步改写：`agentConfig` 的使用点由三个降为两个（`task_execution_log`、`prod_view`，随
B11–B12 迁出），并补一句「B10 之后同理」的说明。`drizzle.config.ts` 的 schema 数组插入本包路径并更新注释。

**台账删 1 条**：`apps-boundary @fenix/resource-memory → @fenix/server-app`（B9 后 5 条之一）随本批归零 →
删除。实测 `architecture:check` → **9 条已登记例外**（= `apps-boundary` 4 + `undeclared-workspace-dependency` 5）；
`check:dependencies` → **2282 modules**（B9 基线 2281，+1 = 新 schema 文件）/ 10 条已登记例外 / **0 条新增违规**。
开批前已确认新增边 `memory/db → agent-config/db` 与 B9 的 `knowledge/db → agent-config/db` 同向同类（指向
「汇」节点，无法折回），不闭合任何新回路。

**负例载体消失的第二处（web 面守卫，实测复现）**：`memory/web/__tests__/memory-browser-surface.test.ts` 的
负例与 B9 的 knowledge 同形——一半断言「poisoned 图里必然出现 `@server/*` 说明符」，本批归零后转红（实测
1 fail，`Expected: > 0 / Received: 0`）。按同一 §4.7.1 ③ 收缩定式替换取证，不直接删：

- 原职责是证明「递归够深、没有停在第一跳」，替换为**两条同强度证据**：① 到达服务端子图里最深的一层
  `src/server/repositories/agent-memory-config.ts`（B9 用过的手法）；② 经该文件的自引用出口跨出包边界到达
  `db/schema.ts`——这条是本包特有的**更强**证据（实测 poisoned 图 45 个文件，还继续经 `agent-config/db` 到达
  identity / model-management / machine / mcp / skill 五个包的 `db/schema.ts`，证明多跳跨包递归仍然成立）；
- 保留「未白名单外部依赖」半条（`zod` / `drizzle-orm` / `elysia` 仍在图里）；
- 注释写明它当初证明的是什么、为什么换证，并交叉引用 §7.21。

**B10 的跨包波及面（本批唯一超出单包范围的改动，precheck 实测发现）**：`bun run precheck` 首跑
package-tests **7 fail**（observer / mcp / sandbox / machine / agent-config / workflow / model-management 七个包的
浏览器面守卫负例同一处报错 `Expected: > 0 / Received: 0`）。根因不是这七处用例各自的问题，而是一条此前
**无人知晓的隐性依赖**：这些包的 poisoned 图会经上游包递归到 `@fenix/resource-memory`
`src/server/repositories/agent-memory-config.ts`，而它那行 `@server/db/schema` 正好是全仓资源包里**最后一条**
宿主表定义导入——七条 `@server/` 取样断言都搭在这条残留上（本次探针实测：B9 树上 sandbox 的 poisoned 图
313 个文件、唯一 `@server/` 引用就发自 memory 那个文件）。B10 清掉它，七条断言同时失去载体。用 B9 提交
`f908dafef` 的独立 worktree 对照实测（同一命令 **15 pass / 0 fail**）确认因果，而非「本来就在红的既有失败」。

处置按同一 §4.7.1 ③ 定式，且这次是**升级而非替换**：七处的 `@server/` 断言由「必须出现（取样）」改写为
「必须为空（全图零容忍）」——原来那条命中的根本不是本包文件发出的引用，改后断言反而不依赖任何别的包的
内部状态，与各文件正向图的同名断言同口径；「递归够深」由保留的两条 `poisoned.files` 断言
（`src/server.ts` + `src/server/**` 至少一个文件）与 `node:` 内建断言承担。九处守卫（七处 + memory 自身 +
B9 的 knowledge，后者同批补上零容忍那一条）现已同形。**未改** `resource-task` / `resource-prod-view` /
`resource-channel` 三处：它们自身仍持有宿主表定义（owner 1.7 台账余 4 条），poisoned 图确实还命中 `@server/`，
零容忍会在那里错误报红，待各自那张表迁出时（B11–B13）随同形改写。

**验证**：`check:schema-ddl-drift` 零差异；`architecture:check` 通过（2140 files，10 rules，9 条已登记例外）；
`check:dependencies` 通过（2282 modules，10 条已登记例外，0 条新增违规）；`generate:module-registry --check`
通过（17 个 manifest，新增的 `./db` 键不影响清单）；`tsc -p apps/server/tsconfig.json` 与
`tsc -p apps/web/tsconfig.json --noEmit` 均无错误；`bun test packages/resources/memory` → **107 pass / 0 fail /
276 expect() calls / 10 文件**（+1 expect 来自新增的递归深度断言，用例数与 B9 相同）。

**precheck 实测**：首跑 **7 fail**（即上面的跨包波及面，根因定位后按零容忍改写）；处置后复跑
`env -u ANTHROPIC_MODEL bun run precheck` → **15 步全绿**（84706ms）：format / import-sort /
module-registry（17 个 manifest）/ web-contributions / owner-inventory / schema-ddl-drift / architecture /
tsc（server、web、app skeletons）/ dependency-boundaries / lint / server-and-script-tests（806 pass / 0 fail，
65 files）/ package-tests（7998 tests：**7996 pass / 2 skip / 0 fail**，641 files，19401 expect）/
web-app-tests（319 pass / 0 fail）。用例总数与 B9 相同（本批不加测试文件、只改断言；`expect` +3 = knowledge 与
memory 各补一条零容忍断言 + memory 新增两条 `poisoned.files` 深度断言，七处的零容忍改写是等量替换）。

**沿用既有处置的一处**：`@fenix/agent-config` 的 workspace 声明**不在本批更新 `bun.lock`**——B7–B9 已按同一
口径留下三批未同步的 `package.json` 声明，`bun install` 与未使用依赖清理统一归 §8.1 第 12 条的「B 块收尾
（依赖清理）」（CI 的 `--frozen-lockfile` 在收尾批一次性恢复一致，不在批次内制造大范围锁文件 diff）。

**未新增缺口**：本批没有引入新的门禁盲区或既有缺陷；§8.4 第 3 条（余 4 条豁免）与第 4 条（收口计数）按本批
事实改写。**一处跨包改动已在上面单独登记**（七处守卫的零容忍改写），它属于「B10 清掉那条残留」的直接后果，
不是顺手重构。

### 7.23 B11：`prod_view` 迁至 `@fenix/resource-prod-view/db`（2026-09-22，本批）

**表与依赖**：单表，DDL 逐字搬入新建的 `packages/resources/prod-view/db/schema.ts`（45 行；表名、列名、
默认值、索引名、`agent_id` 的级联删除一字未动，位置搬迁由 `check:schema-ddl-drift` 实测零差异）。行类型
`ProdViewRow` / `ProdViewInsert` 随表一并搬入，保持宿主定义期的导出面不变。跨包外键目标一条：`agentConfig`
（`@fenix/agent-config/db`，`prod_view.agent_id`）。**`package.json` 只新增 `./db` 出口，依赖声明零改动**——
`@fenix/agent-config` 早已因 web 侧消费 `@fenix/agent-config/web` 而声明（B7 时就已存在），本批的
`db/schema.ts` 外键导入因此不触发 §4.7.1 第 2 条，这与 B9 / B10 各需新增一条 workspace 依赖不同。
**`dependsOn` 保持 `[]`**：装配校验只扫 `src/**`，表定义表达的是「列对象来自谁的迁移链」而不是运行期耦合
（口径与 B9 / B10 同形，manifest 注释已补这一段并列出三个同口径先例）。

**调用期读取点收口：0 处**（与 B6 / B10 同形）。`prod_view` 的读写从一开始就在本包仓储里，且**全仓无第二个
读取者**：实测 `command grep -rn "prod_view\|ProdViewRow\|ProdViewInsert" apps packages scripts`（排除
`packages/resources/prod-view/`）只在宿主 `schema.ts` 命中表定义与注释，宿主无 repository / service / 路由读取
本表，其它包也没有（`agent-config` 等包不读发布视图）。因此本批只换 import 来源，不换消费路径，也不涉及
§4.7.1 第 4 条的跨包写。

**表定义的自引用写法**：仓储的 import 从 `@server/db/schema` 改为 `@fenix/resource-prod-view/db`（**包名
自引用**）。本包**没有** `tsconfig.json`（只有 memory 与 agent-config 各有一份），因此本包的解析口径**从一
开始就只有包 `exports` 一条**——自引用与跨包消费方走的是完全相同的解析路径，不存在相对路径这条岔路
（同形先例：`@fenix/agent-config` 的表定义也在用包名自引用）。

**宿主 `schema.ts`**：删表定义与两个行类型共 22 行、再删因此失效的 `sql` import 1 行，头部注释按 B11 事实
改写（−4 / +6 行内），净 **296 → 275 行**。宿主对这张表的唯一引用方是本包（仓储与包内夹具，均已改指该出口），
因此本文件**连 import 也不必新增**——与 B9 / B10 同为「迁出后宿主零 import 残留」的形态。头部注释同步改写：
`agentConfig` 的使用点由两个降为一个（只剩 `task_execution_log`，随 B12 迁出），并补一句「B11 同理」说明。
`drizzle.config.ts` 的 schema 数组插入本包路径（`model-management` 之后）并更新注释。

**顺手清掉的一处 lint 警告（本批引入，非既有）**：`sql` 在宿主 `schema.ts` 里的**唯一**使用点就是
`prod_view.modules_config` 的 `.default(sql\`'{}'\`)`，表迁走后该 import 立即变成 unused。这不是靠眼看发现的
——首跑 `precheck` 的 lint 步报 `Found 1 warning`（`apps/server/src/db/schema.ts:4` 的
`noUnusedImports`）才暴露；删除该行后复跑 lint 零警告（质量红线「warning 清零」）。记录它的价值在于说明
门禁是活的：B 块搬表在宿主侧的连带改动里，「迁走的表是文件中某 import 的唯一消费者」这类残留会被 lint 直接
点名，不需要人工枚举。

**包内文档同步（README 五段式，契约测试条件 6 会核对段体长度）**：出口表由 5 条增至 6 条（加 `./db` 行）；
「边界残留」的表定义条整段改写为「**宿主内部导入已归零（§1.7 B11）**」并给出复核命令（`command grep -rn
--include="*.ts" --include="*.tsx" -E 'from "@server/' src web db` → **0 处**）；「服务端交付物」的数据条补上表
对象的持有点与自引用写法；W3 宿主 patch 清单第 3 条改为「条目已随 B11 删除」、第 4 条补上本包 `./db` 那条
自引用。**另订正一处文档与代码不一致（非本批引入）**：README 与 `fenix.module.ts` 都把装配依赖写成
`@fenix/agent-runtime/server`，而 1.7 B8 已把该出口改名为 `@fenix/agent-runtime/runtime`（实测
`src/server/services/prod-view.ts:1` 是 `getBoundAgentRuntime` from `/runtime`）——按「文档与代码不一致先核实
意图再同步修正文档」一并改指 `/runtime`。包内自测计数也一并更新：README 原写「2026-09-20 实测 112 pass」，
实测该数字早已过期（B10 提交上即为 116 pass），改为「2026-09-22 实测 116 pass / 0 fail / 10 文件」。

**台账删 1 条**：`apps-boundary @fenix/resource-prod-view → @fenix/server-app`（B10 后 4 条之一）随本批归零 →
删除，台账 **19 → 18 条**（`apps-boundary` 3 + `no-circular` 10 + `undeclared-workspace-dependency` 5）。
实测 `architecture:check` → **8 条已登记例外**（B10 基线 9，−1）；`check:dependencies` → **2283 modules**
（B10 基线 2282，+1 = 新 schema 文件）/ 10 条已登记例外 / **0 条新增违规**。开批前已确认新增边
`prod-view/db → agent-config/db` 与 B9 / B10 的两条同向同类（指向「汇」节点，无法折回），不闭合任何新回路。

**负例载体消失的第三处（web 面守卫，探针实测先行）**：`packages/resources/prod-view/web/__tests__/
prod-view-browser-surface.test.ts` 的负例含「poisoned 图里必然出现 `@server/*` 说明符」，本批归零后该断言
必然转红。按 §4.7.1 ③ 的收缩定式替换取证，**但这次先做探针再改**：实测（`walkValueGraph(WEB_ENTRY,
["@fenix/resource-prod-view/server"])`）poisoned 图 487 个文件 / 2055 条引用，`@server/` 引用**恰好 1 条**，
且发自本包自己的 `src/server/repositories/prod-view.ts`——也就是说这条断言此前**没有**搭在别的包的残留上，
不存在 B10 那种跨包波及面（改后复测：488 个文件 / 2058 条引用 / **0 条** `@server/`）。处置：

- 原职责是证明「递归够深、没有停在第一跳」，替换为**两条同强度证据**：① 到达服务端子图里最深的一层
  `src/server/repositories/prod-view.ts`；② 经该文件的自我引用出口跨出包边界到达 `db/schema.ts`（同形先例：
  B10 的 memory 负例）；
- 「必须出现 `@server/*`」半条按 B10 定式**升级为零容忍**（`toEqual([])`），并保留「未白名单外部依赖」半条
  与 `node:` 内建半条；
- 注释写明它当初证明的是什么、为什么换证，并交叉引用 §7.21 / §7.22。

**契约测试的同步收缩（§4.7.1 第 3 条的正面案例）**：`src/__tests__/prod-view-package-contract.test.ts` 把
「宿主导入只允许 `@server/db/schema`」的白名单整体删除，四处同批改写——

1. 常量 `ALLOWED_HOST_IMPORT`（`@server/db/schema`）→ `PKG_DB_EXPORT`（`@fenix/resource-prod-view/db`），
   语义由「放行一条残留」变成「把表对象的取用面钉在本包出口上」；
2. **条件 1**：`@server/` 白名单外的违规 → **零例外**（任何 `@server` 说明符都是违规，含深路径与动态
   `import()`）；
3. **扫描有效性自检的正向控制**（§4.7.1 第 3 条点名的、当批必然失败的那条）：原断言「`@server/db/schema`
   的出现次数 > 0」改为 `toContainEqual(objectContaining({ file: 仓储, specifier: PKG_DB_EXPORT }))`，形状
   照抄 machine 包（`§7.19`）的同名改写——它同时是行为契约：若有人把取表改回宿主 schema 或别包的 `db`，
   它会立刻变红；
4. **条件 8 其六 / 其一**：改指本包出口（`schemaImportNames` 泛化为 `importNames(file, specifier)` 并加
   `escapeRegExp`，后者是「说明符含 `.` `-` `/`」的必然要求）。

**B10 那样的跨包波及面在本批没有出现（实测确认，不是推断）**：B10 清掉 memory 残留时，七处守卫的
`@server/` 取样断言同时失去载体；B10 已把它们升级为**零容忍**，而本批的动作只会**减少** `@server/` 的出现，
因此那七处不会转红——`precheck` 的 package-tests 实测 **0 fail** 印证（不是「没测到」，是用例数 7998 不变、
`expect` 由 19401 增至 19403 = 本批新增的两条 `poisoned.files` 深度断言）。同理，`resource-task` /
`resource-channel` 两处仍保持 B10 时的原形（它们自身仍持有宿主表定义，各自的表待 B12 / B13 迁出时同形改写
——`resource-task` 已按此预告在 §7.24 同形改写）。

**验证**：`check:schema-ddl-drift` 零差异；`architecture:check` 通过（**2141 files**，10 rules，8 条已登记
例外）；`check:dependencies` 通过（**2283 modules**，10 条已登记例外，0 条新增违规）；
`generate:module-registry --check` 通过（17 个 manifest，新增的 `./db` 键不影响清单）；`tsc -p
apps/server/tsconfig.json` 与 `tsc -p apps/web/tsconfig.json --noEmit` 均无错误；`bun test
packages/resources/prod-view` → **116 pass / 0 fail / 10 文件 / 327 expect**（B10 提交 `f668f3ad6` 的独立
worktree 对照同命令为 **116 pass / 325 expect**：用例数不变，`expect` +2 = web 面守卫新增的两条
`poisoned.files` 深度断言，契约测试的四处改写为等量替换）。

**precheck 实测**：首跑 `env -u ANTHROPIC_MODEL bun run precheck` **15 步全绿（85154ms）但 lint 报 1 warning**
——即上面那条 unused import（步骤不失败，是因为 ci.ts 的 lint 过滤只把「有 error 或有 warning」的原始行打印
出来而不改退出码，所以绿不等于零警告）。删除该行后**最终状态复跑** → **15 步全绿（85496ms）**，lint 零警告：
format / import-sort / module-registry（17 个 manifest）/ web-contributions / owner-inventory /
schema-ddl-drift / architecture / tsc（server、web、app skeletons）/ dependency-boundaries / lint /
server-and-script-tests（806 pass / 0 fail，65 files）/ package-tests（7998 tests：**7996 pass / 2 skip /
0 fail**，641 files，**19403 expect**）/ web-app-tests（319 pass / 0 fail）。

**沿用既有处置的一处**：本批 `package.json` 只加 `./db` 出口键、不改依赖声明，因此连「待 `bun install` 同步」
的清单都不增长；B7–B10 留下的 workspace 声明差异仍统一归 §8.1 第 12 条的「B 块收尾（依赖清理）」。

**未新增缺口**：本批没有引入新的门禁盲区或既有缺陷；§8.4 第 3 条（余 4 条 → **余 3 条**）与第 4 条（B11
收口 **0 处**）按本批事实改写。**两处非显然取舍已在此登记**：① 行类型随表搬入包 `db/`（而不是留在宿主或
删掉）——保持定义期导出面、避免迁移混入未要求的 API 收缩；② 契约测试的扫描集 `SOURCE_ENTRIES` 本就含
`db`，因此新表定义自动进入条件 1 / 2 / 3 / 4 的扫描面，无需额外扩集（B4 审计补正的扫描集在此得到预期回报）。

### 7.24 B12：`scheduled_task_v2` / `task_execution_log` 迁至 `@fenix/resource-task/db`（2026-09-22，本批）

**表与依赖**：两张表，DDL 逐字搬入新建的 `packages/resources/task/db/schema.ts`（77 行；表名、列名、默认值、
索引名、`user_id` 的级联删除与 `agent_id` 的 `onDelete: "set null"` 一字未动，位置搬迁由
`check:schema-ddl-drift` 实测零差异）。行类型 `ScheduledTaskV2Row` / `ScheduledTaskV2Insert` 随表一并搬入；
`TaskExecutionLogRow` / `TaskExecutionLogInsert` **留在原处**——它们本来就由
`src/server/repositories/task.ts` 从表对象 `$inferSelect` 现推，宿主从未定义过这两个类型，搬进 `db/` 只会
凭迁移顺手扩出一个无人消费的新公共面（登记为下表「非显然取舍」之一）。跨包外键目标两条：
`agentConfig`（`@fenix/agent-config/db`，`scheduled_task_v2.agent_id`）与 `user`（`@fenix/identity/db`，
`scheduled_task_v2.user_id`）；`task_execution_log.task_id` **无外键**（历史如此，v1 / v2 任务 ID 混存）。
`package.json` 新增 `./db` 出口**与一条 workspace 依赖** `@fenix/identity`（`@fenix/agent-config` 早已因 web
侧消费而声明）——新增方向与 agent-config / knowledge / memory 的同名导入同形，`db/**` 路径整体落在 §6.1 的
跨模块外键 schema 组装期例外内（`scripts/lib/architecture-boundary-rules.ts` 的 `isSchemaAssemblyPath`，
`special-dependency` 与 `apps-boundary` 都不对它判定），因此**不新增台账条目**。
**`dependsOn` 保持 `[]`**：装配校验只扫 `src/**`（`db/schema.ts` 的列对象导入不进 `dependsOn`），口径与
B9 / B10 / B11 同形，manifest 注释已补这一段。

**调用期读取点收口：0 处**（与 B6 / B10 / B11 同形）。实测
`command grep -rln "scheduledTaskV2\|scheduled_task_v2\|taskExecutionLog\|task_execution_log" apps packages
--include="*.ts" --include="*.tsx"`（排除 `packages/resources/task/`）只命中三处：宿主被迁走的表定义本身、
宿主 schema 头部注释、以及 `round19-isolated-repository-boundaries.test.ts`（它经 `@fenix/resource-task/server`
消费 `taskExecutionLogRepo`，不读表对象）。宿主无 repository / service / 路由读写这两张表，其它包也没有。
因此本批只换 import 来源，不换消费路径，也不涉及 §4.7.1 第 4 条的跨包写。

**表定义的自引用写法**：仓储的 import 从 `@server/db/schema` 改为 `@fenix/resource-task/db`（**包名自引用**，
3 条语句：`repositories/task-v2.ts` 的类型导入 + 值导入、`repositories/task.ts` 的值导入），包内 3 个用例文件
的 `import type` 同批改指。本包**没有** `tsconfig.json`，解析口径本来就只有包 `exports` 一条，自引用与外部
消费方走完全相同的路径（同形先例：agent-config / prod-view 的表定义）。

**宿主 `schema.ts`**：删两张表定义与两个行类型共 49 行、再删因此失效的 `agentConfig` import 1 行，头部注释按
B12 事实改写（净 +1 行内），**275 → 226 行**。宿主对这两张表的唯一引用方是宿主测试（下条），因此本文件删完
**连 import 也不必新增**——与 B9 / B10 / B11 同为「迁出后宿主零 import 残留」的形态。
**另订正一处文档与代码不一致（B11 时写错，非本批引入）**：头部注释曾把 `agentConfig` 的使用点记为
`task_execution_log`「引用一次 `agent_config.id`」，实测该表**没有** `agent_config` 外键——宿主侧唯一真正的
使用点是 `scheduled_task_v2.agent_id`（删掉它之后 `@fenix/agent-config/db` 这个 import 才真正归零）。按
「文档与代码不一致先核实意图再同步修正文档」在注释里写明订正与实测口径。
`drizzle.config.ts` 的 schema 数组插入本包路径（`sandbox` 与 `workflow` 之间）并更新注释。

**`agentConfig` 那条 unused import 的连带处置（B11 经验，非门禁报出）**：它在本批是「迁走的表是该 import 的
唯一消费者」的第二次出现。B11 是靠首跑 precheck 的 lint 步报出（`noUnusedImports`）才发现的，本批按同一定式
在改动时即一并删除，**首跑 precheck 即 15 步全绿、lint 零警告**，无需门禁再报一次。

**表定义残留的宿主测试：就地改指 owner 出口（两处非显然取舍之一）**：`apps/server/src/__tests__/
task-schema.test.ts:3` 原从宿主 `../db/schema` 取 `taskExecutionLog` 做列名断言，本批改指
`@fenix/resource-task/db`。两条候选路径：

- **（a，采纳）就地改指 owner `./db`**：属 B3 已裁定的 carve-out「宿主经 owner `./db` 读写不算违规」的既有
  形态（生产侧先例：`apps/server/src/db/schema.ts` 转出 identity 表对象、`services/data-migrates/*` 直接按归属
  取各包 `db/` 出口）；且宿主路径被两个 gate 钉住——`scripts/root-source-owner-rules.ts:50` 按
  `src/__tests__/task-schema.test.ts` 登记 owner 说明，`scripts/__tests__/rmd-07-migration.test.ts:45` 更以
  `existsSync(目标) === true` 的成对断言要求该宿主路径存在。**这是宿主测试首次 import owner `./db` 出口**
  （此前只有生产代码有先例），故在此显式登记：新增的是「宿主测试 → owner `db` 出口」这一条读取形态，不是
  新的依赖方向。
- **（b，不取）把测试移入 owner 包**：符合「迁移任务优先复用并移动既有测试」，但要动 `rmd-07-migration.test.ts`
  与 `root-source-owner-rules.ts` 两个 gate 文件（连同 README 与 §7 记录），代价明显高于收益，且文件内自写的
  SQLite 建表 DDL 与列名断言（`PRAGMA table_info`）**与本批无关**——它不取 Drizzle 表对象，本来就不受迁移影响。

**负例载体消失的第四处（web 面守卫，探针实测先行）**：`packages/resources/task/web/__tests__/
task-browser-surface.test.ts` 的负例含「poisoned 图里 `@server/*` 违规数 > 0」，本批归零后该断言必然转红。
按 §4.7.1 ③ 的收缩定式替换取证，**先探针后改**：实测（`walkValueGraph(WEB_ENTRY,
["@fenix/resource-task/server"])`）poisoned 图 **495 个文件 / 2111 条引用**，`@server/` 引用**恰好 2 条**，
两条都发自本包自己的仓储（`repositories/task.ts` 与 `repositories/task-v2.ts` 的 `@server/db/schema`），
即该断言此前**没有**搭在别的包的残留上（不存在 B10 那样的跨包波及面）。处置与 B11 同形：把「`@server/*`
非空」半条**升级为零容忍**（`toEqual([])`），并补**两条深度断言**承担「递归够深、没有停在第一跳」——
① 到达服务端子图里最深的一层 `src/server/repositories/task-v2.ts`；② 经该文件对 `./db` 出口的**自我引用**
跨出包边界到达 `db/schema.ts`。改后复测：**496 个文件 / 2114 条引用 / 0 条 `@server/`**，`db/schema.ts`
可达（探针数字与结论都写进测试注释）。保留「未白名单外部依赖」半条与 `node:` 内建半条。

**契约测试的同步收缩（§4.7.1 第 3 条）**：`src/__tests__/task-source-migration.test.ts` 三处改写 + 一处补集——

1. 常量 `ALLOWED_HOST_IMPORT`（`@server/db/schema`，语义是「放行唯一一条残留」）→ `PKG_DB_EXPORT`
   （`@fenix/resource-task/db`，语义变成「把表对象的取用面钉在本包出口上」）；
2. **条件 1**：`@server/` 白名单外的违规 → **零容忍**（`ref.specifier.startsWith("@server/")` 直接判违规，
   含深路径与动态 `import()`）；
3. **扫描有效性自检的正向控制**（当批必然失效的那条）：原「`@server/db/schema` 出现次数 > 0」改为
   `toContainEqual(objectContaining({ file: 仓储, specifier: PKG_DB_EXPORT }))`，形状照抄 B11 / machine 包；
   它同时是行为契约——若有人把取表改回宿主 schema 或别包的 `db`，它会立刻变红；
4. 该用例的「关键文件都在扫描集内」清单补 `db/schema.ts`（`SOURCE_ENTRIES` 本就含 `db`，此处只是把新文件
   显式列入自检，属可选加强）。

本包契约测试**没有** B11 条件 8 那类「出口只被取用某某一族符号」的断言，故不涉及那两处改写。

**包内文档同步（README 五段式）**：出口清单补 `./db` 行；「依赖边界」首段把「`@fenix/(identity|access-control)`
实测 0」的 grep 口径收窄到 `src` + `web`，并新增一段说明 `db/schema.ts` 的 `@fenix/identity/db` 是 §6.1 组装期
例外、不是调用期依赖（否则这条实测断言会与本批改动直接冲突）；「宿主导入只剩表定义」整段改写为「**宿主内部
导入已归零（§1.7 B12）**」并给出复核命令与实测结果（`git grep -nE "from \"@server/" -- packages/resources/task`
→ 仅 1 行命中，是 `src/server/db.ts` 注释里的旧写法示例，可解析导入 **0 处**）；「配置与 DB」的表对象来源条、
「边界外的已知项」的台账条与宿主侧收口条同批改写；`fenix.module.ts` 与 `src/server/db.ts` 的注释按 B12 事实
改写（后者记录「表定义从宿主迁入本包时该文件确实一行未改」——句柄类型刻意不写 `typeof schema` 在 B12 得到
回报）。
**另订正一处过期计数（非本批引入）**：README 原写「2026-09-20 实测 320 pass / 511 expect」，用 B11 提交
`a9dd5f8c4` 的独立 worktree 对照实测，改动前该命令已是 **321 pass / 516 expect**（另有一处 19 个文件的记载
仍准确），改为「2026-09-22 实测 321 pass / 0 fail / 519 expect」并注明订正。

**台账删 1 条**：`apps-boundary @fenix/resource-task → @fenix/server-app`（rationale 原文「实测 6 处导入 /
6 个文件，全部为 `@server/db/schema` 表定义导入」）随本批归零 → 删除，台账 **18 → 17 条**
（`apps-boundary` **2** + `no-circular` 10 + `undeclared-workspace-dependency` 5；`json.dumps(d,
ensure_ascii=False, indent=2) + "\n"` 逐字一致断言后再写回，`git diff --stat` 恰为 8 deletions）。实测
`architecture:check` → **2142 files**（B11 基线 2141，+1 = 新 schema 文件）/ 10 rules / **7 条已登记例外**
（B11 基线 8，−1）；`check:dependencies` → **2284 modules**（B11 基线 2283，+1）/ 10 条已登记例外 / **0 条新增
违规**。开批前已确认新增边 `task/db → identity/db` 与 `task/db → agent-config/db` 与 B9 / B10 / B11 的两条
同向同类（指向「汇」节点，无法折回），不闭合任何新回路——实测 0 条新增违规印证。

**验证**：`check:schema-ddl-drift` 零差异；`generate:module-registry --check` 通过（17 个 manifest，新增的
`./db` 键不影响清单）；`tsc -p apps/server/tsconfig.json` 与 `tsc -p apps/web/tsconfig.json --noEmit` 均无
错误；`bun test packages/resources/task` → **321 pass / 0 fail / 19 文件 / 519 expect**（B11 提交的独立 worktree
对照同命令为 **321 pass / 516 expect**：用例数不变，`expect` +3 = web 面守卫新增的两条 `poisoned.files` 深度
断言 + 正向控制改写（`toBeGreaterThan` 1 条 → `toContainEqual(objectContaining(...))` 2 条））；宿主
`bun test apps/server/src/__tests__/task-schema.test.ts` → 2 pass / 0 fail；`scripts/__tests__/
rmd-07-migration.test.ts` → 2 pass / 0 fail（宿主路径未动、成对断言仍成立）。

**precheck 实测**：`env -u ANTHROPIC_MODEL bun run precheck` 首跑即 **15 步全绿（86725ms）**、lint 零警告：
format / import-sort / module-registry（17 个 manifest）/ web-contributions / owner-inventory /
schema-ddl-drift / architecture / tsc（server、web、app skeletons）/ dependency-boundaries / lint /
server-and-script-tests（806 pass / 0 fail，65 files）/ package-tests（7998 tests：**7996 pass / 2 skip /
0 fail**，641 files，**19406 expect**，B11 基线 19403 +3）/ web-app-tests（319 pass / 0 fail）。

**沿用既有处置的一处**：本批 `package.json` 除出口键外新增了一条 workspace 依赖（`@fenix/identity`），
`bun.lock` 仍不动，与 B7–B11 留下的声明差异统一归 §8.1 第 12 条的「B 块收尾（依赖清理）」——该条清单随之
增长一条。

**未新增缺口**：本批没有引入新的门禁盲区或既有缺陷；§8.4 第 3 条（余 3 条 → **余 2 条**）与第 4 条（B12
收口 **0 处**）按本批事实改写。**两处非显然取舍已在此登记**：① 行类型的搬入面**严格等于宿主原有的导出面**
（`ScheduledTaskV2Row` / `Insert` 搬入，`TaskExecutionLogRow` / `Insert` 留在仓储现推，不凭迁移扩公共面）；
② 宿主测试就地改指 owner `./db` 出口而不是移入 owner 包（理由与两个 gate 的耦合见上，且这是宿主**测试**首次
引入该读取形态）。

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
| 11 | **`model-management` 没有 source-migration 契约测试**（machine / mcp / sandbox / agent-config / workflow / task 六个包均有），因此 §4.7.1 ③ 的「残留数 > 0」正向控制在 B3 无从收缩，该包与宿主的边界在测试层无人守护（只靠 `apps-boundary` 台账 + `check:dependencies`） | B 块收尾 | 按同形测试补一份。**口径已随 B7 更新**：该包 `src/**` 的 `@server/**` 残留已归零（B7 把 `repositories/subject-agent-search.ts` 收窄为薄适配层，检索 SQL 归 agent-config 的 `searchAgentConfigsSystem`，见 §7.19），因此新用例的断言是「零宿主导入」（与 machine / mcp / skill / observer 同形），不再有「残留数 > 0」的正向控制可收缩——正向控制改用一条非宿主说明符（如 `@fenix/platform-sdk`）与实际存在的相对导入 |

| 12 | **`observer` 的 `drizzle-orm` 声明在本批后成为未使用依赖**：B7 删掉该包唯一的 DB 句柄与仓储后，全包 `src/**`、`web/**` 再无 `drizzle-orm` 导入（仅一处浏览器面测试的注释提到它）。删除声明需要跑 `bun install` 更新 `bun.lock`，本批不动锁文件 | B 块收尾（依赖清理） | 删 `packages/resources/observer/package.json` 的 `drizzle-orm` 条目并 `bun install`，与其它包的未使用依赖一并清理 |

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
| 3 | owner=`1.7` 的 `apps-boundary` 豁免按「该包最后一个跨模块表读取消失」逐条退场（§4.8 第 2 条）。B4 与 B6 各删 1 条（sandbox 见 §7.14、workflow 见 §7.17）；**B7 一次删 5 条**（machine / model-management / mcp / skill / observer，五包 `src/**` 与 `db/**` 的 `@server` 引用同时归零，见 §7.19）；**B9 再删 2 条**（`agent-config` 与 `resource-knowledge`，两包 `src/**`、`web/**`、`db/**` 的 `@server` 引用同时归零，见 §7.21）；**B10 再删 1 条**（`resource-memory`，该包 `src/**`、`web/**`、`db/**` 的 `@server` 引用同时归零，见 §7.22）；**B11 再删 1 条**（`resource-prod-view`，该包 `src/**`、`web/**`、`db/**` 的 `@server` 引用同时归零，见 §7.23）；**B12 再删 1 条**（`resource-task`，该包 `src/**`、`web/**`、`db/**` 的 `@server` 引用同时归零，见 §7.24），**余 2 条**（`agent-runtime` / `resource-channel`）；其余多数要等目标表迁出后其读取点同批收口，**只能在 B 块末期集中清零**。**B8 的实测给这条口径补了第二种形态**：`agent-runtime` 的生产侧已随两张表迁出**归零**（0 条 / 0 文件），但本条**仍不能删**——残留的 17 处全在测试侧（宿主测试基建替身登记），与生产引用面无关；该条的 `removeWhen` 因此由「表定义迁出」改写为「测试侧归零」（见 §7.20）。**删除条件不能只看「本包的表迁完」或「生产侧归零」，要看该条从「包对」粒度判定的全部匹配面** | B 块收尾 | 各目标表迁完后逐包核对「不再引用 `@server/**`」（含测试侧），逐条删除并留证据；`architecture:check` 的 stale 检测是充分证据 |
| 4 | 剩余 7 批（B7–B13）各有若干跨包调用期表读取需一并**改为经 owner 公开入口或宿主注入端口取数**（§4.8 第 1 条 B1 实测 19 处为 B 块**读**总数，B2 收口 1 处、B3 收口 1 处、B5 收口 1 处、B6 收口 **0 处**——该包九张表无任何跨包读取者，见 §7.17，**B8 收口 1 处**（`agent-config-resource.ts` 的 `listBoundEnvironmentIds` 直读 `environment`，改经 owner 的 `listEnvironmentIdsByAgentConfig`，见 §7.20），**B9 再收口 1 处**（`agent-config` 的 `agent-related-resources.ts` 直读宿主 `knowledge_base`，改经 `@fenix/resource-knowledge/server/summaries`，见 §7.21——本批后 `agent-config` 的跨包表读取为 **0**，`getAgentConfigDatabase()` 只剩该包自己的 `agent_site_app`）；**B10 收口 0 处**（`agent_memory_config` 的跨包读写从一开始就只经本包 `./server` 的 `isAgentMemoryEnabled` / `setEnabled`，宿主侧零读取点，见 §7.22）；**B11 收口 0 处**（`prod_view` 的读写全在本包仓储，全仓无第二个读取者，宿主侧无 repository / service / 路由读取本表，见 §7.23）；**B12 收口 0 处**（`scheduled_task_v2` / `task_execution_log` 的读写全在本包仓储，宿主无 repository / service / 路由读写这两张表；唯一的包外读取是宿主测试 `task-schema.test.ts` 的列名断言，就地改指 owner `./db` 出口即完成，见 §7.24）；B4 不在其中：它消除的是**跨包写**（machine 写 `sandbox_instance`），见 §7.14，2026-09-22 审计订正——本节此前把 B4 也减了一次，与「19 处是读口径」自相矛盾；B8 的**写**（删 `environment` 行）另记，见本项末句与 §4.8 第 7 条）；只改指 owner 的 `./db` 不算完成（§4.8 第 4 条）。**B7 收口的是 `agent_config` 一族（5 张表）的全部跨包读取点**：`agent-runtime` 2 个文件（改经宿主注入的 `AgentConfigLookupPort` 新增方法）、`machine` 1 个文件（删除守卫改经 `isAgentConfigBoundToMachine`）、`model-management` 1 个文件（主体检索改经 `searchAgentConfigsSystem`）、`observer` 1 个文件（归属查询改经 `listAgentConfigsByOrganization`，见 §7.19）；`mcp` / `skill` 没有跨包读取——它们读的是自己的关联表，表随聚合根迁走后读取点归 `agent-config` 自己。**逐包清单目前无权威落点**——§4.8 #1 与本节原先的「见 §7.10」所指清单在 §7.10 中不存在，审计已指出；B7 因此改为按「本批实际改动的文件」实数枚举，不再在 19 这个从未落盘分项的总数上继续加减 | 各批同批（清单并入 B 块末期，与本节第 3 条同一次扫描） | 每批交付面含全部读取点，漏改会让 preload 的模块链接期抛错（§4.8 第 1 条）、且残留 §6.1 边界 1 违规；末期逐包核对时一并产出完整清单 |
| 5 | **门禁缺口：相对路径伸进别的包 `db/` 两道门禁都不报。** `check-architecture` 的 `CROSS_PACKAGE_SOURCE_PATH`（`scripts/check-architecture.ts:43`）与 dependency-cruiser 的 `no-cross-package-src:<pkg>`（`.dependency-cruiser.cjs:28-30`）判「跨包内部路径」时只认 `src` / `web/src`，新出现的 `db/` 不在任何一侧。审计已用夹具复现（相对路径在 `db/` 与 `src/` 两种位置均 exit 0，同路径改指别包 `src/` 则 exit 1）；当前仓库无实际违规 | B 块收尾 | 把 `db` 纳入「跨包内部路径」判定，但**只对相对路径生效**——裸说明符 `@fenix/<pkg>/db` 是 §6.1 允许的组装期出口，不能一并拦 |
| 6 | **门禁缺口：`check:schema-ddl-drift` 的两处判别力盲区**（B4 主体审计发现，2026-09-22，非本批缺陷）。该门禁只做「`drizzle.config` 声明的 schema 集合 → 与最新 snapshot 的 DDL 差异」，因此：(a) **同一张表被两个已声明样式的模块重复定义**（第二份实现复活）→ 0 差异；(b) 表内**列序变化** → 0 差异（列集与类型没变）。含义是「只搬位置」的机器证据实际来自交付方**同时删掉了旧定义**这个动作，门禁本身识别不了重复定义 | B 块收尾 | 重复定义面可加一条「表名 → 定义文件」唯一性断言（前提是表名的 owner 已按 §4.7 矩阵定完，否则「同一表出现在两个 owner 的 schema 里」与「宿主 barrel 转出」需要区分）；列序面若重要，可对 snapshot 做「逐列序号」比较。两者都要另开任务，不在 1.7 内实现 |
| 6 | 组装期 `db/` 不在「子进程不得整段继承宿主 env」的扫描面内：`scripts/check-dependency-boundaries.ts:54-72` 的文件收集只认目录名 `src`，`packages/*/db/**`（含设计规定的 `db/data-migrations/`）整体跳过。审计判定为**已声明范围**而非漏报（该步骤注释即写明范围只含 `packages/**/src/**`；`db/` 是组装期 + 幂等 DML 层，不构造子进程；实测 db/ 下 2 个文件零 `process.env` / spawn） | 不修，登记备查 | 若日后 `db/data-migrations/` 出现子进程调用，须同步扩大扫描面 |
| 7 | ~~**B7 前置：`agent-runtime` 在查询期 LEFT JOIN `agent_config`**（`services/environment-orchestration.ts`、`services/environment-web.ts`）。`agent_config` 迁出后该导入命中 `.dependency-cruiser.cjs:74-90` 的 `agent-runtime-not-to-resources`（其 `pathNot` 只排除 `packages/agent-runtime/db/` 与 `packages/resources/(machine\|sandbox)/`），而 `check-architecture` 拦不住它。按 §4.8 第 4 条应改为经 agent-config 公开入口取投影（若 `agent-runtime → agent-config` 的包级边不被装配方向允许，则退回宿主注入端口），但 LEFT JOIN → 批量投影查询是一次独立设计（且要避免 N+1）~~ **已闭环（§7.19，2026-09-22）**：两个查询改经宿主注入的 `AgentConfigLookupPort`（新增 `findAgentConfigExecutionFields` / `findAgentConfigNamesByIds` 两个只读投影方法）批量取投影，无 N+1 | 已交付 | 宿主**零文本改动**：接口扩展只落在 agent-config 的实现（`services/agent-config-lookup.ts`）与 agent-runtime 的端口定义上，`apps/server/src/bootstrap/host-startup.ts` / `services/pre-launch-ports.ts` 均未改动（实现对象原地满足扩展后的契约） |
| 8 | ~~**D4 裁定（3 张 join 表归 agent-config）与现有实现冲突。** `agent_config_mcp` 已由 mcp 包自持（`mcp/src/server/services/config/agent-config-mcp.ts`，文件头自述「MCP 包自持」），`agent_config_skill` 同理由 skill 包持有，唯一的读者是各自包内文件。按 D4 迁到 agent-config 会让 mcp / skill 反向导入 `@fenix/agent-config/db`：两者都未声明该包（触发 `undeclared-workspace-dependency`），且 `agent-config → mcp`（7 处）、`agent-config → skill`（9 处）已存在，各自闭合一条**新环**。这是 D4 裁定当时未计入的成本。**B2 实测佐证**（§7.11）：mcp 包的 `agent_config_mcp` 读写口径已由该包自己的 `./server/config` 出口公开，且 B2 迁表后它是该包**唯一**残留的宿主表读取——按 D4 迁走会让这个出口失去唯一内容~~ **已闭环（§7.19，2026-09-22）：维持 D4，三张 join 表全归 agent-config。**冲突的根源是 B2 / B5 期间的「各包自持」中间态，不是 D4 本身——`mcp ↔ agent-config` 与 `skill ↔ agent-config` 反向声明之所以会成环，是因为关联表若留在 mcp / skill 侧，其 `agent_config_id` 外键必须组装期导入本包表对象；表随聚合根进来则零新边、零新环 | 已交付 | — |

**C 块**：C1 的已知破测（`workspace-resolver.test.ts` 4 条、machine 侧 10 个文件因
`initializeMachineModuleConfig` 只注册 `"machine"` 而抛「模块 agent-runtime 未声明应用基础设施配置」）
尚未处理；宿主 env schema 缺 `GOTENBERG_URL` / `RCS_WORKFLOW_HMAC_SECRET` 两键（C2 补）。

### 8.5 边界豁免与依赖残留（§10.7.4）

台账 `scripts/architecture/exceptions.json` 共 17 条（B4 删 sandbox 后为 28 条，B6 删 workflow 1 条、B7 删
5 条，B8 无增删、只更新 2 条，B9 删 2 条，B10 删 1 条，B11 删 1 条，B12 删 1 条，见 §7.14 / §7.17 / §7.19 /
§7.20 / §7.21 / §7.22 / §7.23 / §7.24；实测口径：`bun run architecture:check` 报
7 条已登记例外
（= `apps-boundary` 2 + `undeclared-workspace-dependency` 5，两条规则都定义在
`scripts/lib/architecture-boundary-rules.ts`），`bun run check:dependencies` 报 10 条
（= `.dependency-cruiser.cjs` 的 `no-circular`），两者相加才是 17）：

- **2 条 owner=`1.7`**：均为 `apps-boundary → @fenix/server-app`，属 B 块范围，随宿主收敛清理。B12 后
  余下的是 `agent-runtime`、`resource-channel` 两个包——**B12 之后这两条的成因分成两类**：
  - `resource-channel` 一条的残留仍指向宿主**自有**表（`im_channel*`），那张表迁出时一并收口（B13）；
  - `agent-runtime` 一条**生产侧已归零**，残留全在测试侧（17 处宿主测试基建替身登记），不再随任何表
    迁出消失，`removeWhen` 已改写为「测试侧归零」（§7.20）——B 块末期清零时必须把它与另一条分开判定。
- **15 条 owner=`未排期`**：10 条 `no-circular`（跨包环的「每环一条」代表边）+ 5 条
  `undeclared-workspace-dependency`（`acp-link` 系缺依赖声明）。按台账 `_comment` 的口径，这
  15 条是「门禁修复后被如实暴露出来的既有债务，不属于任何在排任务的范围」。本批不动，按 §10.7.4
  在此登记：**建议在阶段 2 收口时统一排期，或明确写入「接受为长期例外」的理由**，不留在
  「未排期」这一无归属状态。
