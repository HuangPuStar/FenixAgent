# 迁移、治理与测试

> 本文是模块验收、垂直迁移、stable ID、AgentConfig 能力簇、切换/回滚与历史测试治理的 canonical detail。Direct prerequisite、领取状态和 DB journal lock 只以 [`ce-ee-refactoring-collaboration-plan.md` 的任务总表](../ce-ee-refactoring-collaboration-plan.md)为真相；此处不复制任务 DAG。

## 1. 交付原则

迁移目标不是先搬空当前 `src/`、`web/`、`drizzle/` 再补功能，而是逐个交付可运行的垂直切片：

```text
inventory and boundary
  -> package/public surface
  -> schema/data ownership
  -> domain/services/repository
  -> authorization and runtime ports
  -> /app route and resource Web
  -> tests/observability/migration rehearsal
  -> switch all callers
  -> delete old internal implementation
```

允许已迁移和未迁移 module 短暂共存；同一资源、route 或 table 任一时刻只有一个权威写实现。禁止旧/新 service 双写、内部 compatibility Facade、长期 alias 或 name-to-ID 转发。保留外部合同的 protocol adapter 必须直连同一新 Facade，属于正式协议边界，不是第二实现。

首期按协作计划交付 AgentConfig 能力簇，而不是孤立 CRUD：platform/access/data/runtime 基础准备后，Model/Provider、Skill、MCP、Knowledge/Memory 与 Environment/Node/Site App 提供 AgentConfig 当前真实依赖，随后组装 launch snapshot、迁移 AgentConfig 后端与 Web，最后集成演练。Task 的具体 direct edge 与并行领取必须回看权威总表，不能从本段推导新依赖。

### 1.1 当前基线与目标状态

迁移开始前，ARC-01 inventory 是旧实现、表、caller、route、页面、错误与风险的事实基线。
AGT-00 map 是 instance/runtime/relay/cancel/timeout/release 当前行为基线。
二者不能被目标设计反向解释；若代码已变化，owner 先更新或补充可比较证据。

每个切片必须明确三种资产处置：

- **must-delete**：新权威路径切换后删除的内部 route/service/repository/page；
- **retain-and-rewire**：独立领域或协议能力保留，只改为消费公开 Facade/DTO/port；
- **contract-decision-required**：外部消费者或产品语义未决，保持合同并先重接新权威路径。

处置分类不是文件级机械删除清单。
同一文件可能同时包含待删资源逻辑与需保留协议逻辑，必须按责任拆分并用 caller/import tests 证明。
删除前要有 owner、前置、证据、观测窗口和回滚边界；未知资产触发停止条件。

### 1.2 垂直切片的最小可运行性

每个阶段从最小端到端结果开始，不能先铺一整层 package/schema 后长期无法运行。
骨架 task 不切入口；resource task 不在依赖尚未公开时反调旧 service；Web 切换与 server route 在兼容窗口内协调发布。

一个切片的“完成”至少意味着：

- 当前授权主体可以通过稳定 ID 完成该切片承诺的真实动作；
- 数据可从支持的旧版本升级，失败有诊断与补偿；
- 新旧结果、错误与性能有可比较基线；
- 生产入口只指向一个写 owner；
- module、route、Web、background caller 与 external adapter 均已分类；
- rollback image 对当前 schema 和 profile 仍兼容。

Task 的具体 direct edge 与并行领取必须回看权威总表，不能从本段推导新依赖。

EE 准入也只服从总表：平台静态装配基线可支持 EE repo/submodule 准备；企业授权实现等待 signed ARC-02；完整用户链路联调等待 CE M1。不得额外要求 AgentConfig/runtime 全闭环后才开始所有 EE 工作，也不得让 EE 提前复制 CE 资源页面。

## 2. 每个模块的验收要求

每个 module 变更必须：

1. 明确领域 owner、package direct dependencies、capability requires、concrete module dependsOn、租户/授权、失败与并发；
2. 只公开真实消费者所需 DTO/service/port，通过 package export 使用，不穿透内部路径；
3. 修改 `/app` route 时同步 schema/contract fixture，修改 Web 时覆盖 loading、empty、error、retry、unauthorized、success 与 i18n；
4. 修改 schema 时生成并审查完整 DDL/meta，执行空库与升级库 migration；数据变化提供幂等 data migration、观测与补偿；
5. 修改 env/deploy/observability 时同步模板、preflight 和 operations guidance；
6. 运行 module tests、contract tests、typecheck、lint/format；涉及 CE/EE 边界时增加 fixed-submodule integration；
7. 明确切换窗口、old caller search、删除证据、观测窗口与可回滚 revision；
8. 影响长期公共边界且决定已批准时更新架构文档或 ADR；未决事项只回链根 pending table。

ARC-02 首批公共边界已确认；后续实现必须通过默认与 EE provider 的共同 contract tests 证明一致性。根索引中的后置决定只阻塞对应 route、产品或数据实现，不接触这些决定的盘点、fixture 和其他准备可继续。

## 3. 资源垂直切片固定操作

后续资源均遵守以下步骤，但每个资源单独计划和 PR，不能用“大批量迁移所有资源”代替：

1. **盘点**：列出 service、repository、schema、route、页面、任务、外部 API、数据引用、secret 与删除条件。
2. **定界**：确定 stable ID、资源动作、Facade/Domain Service、依赖方向、ownership 与错误分类。
3. **建立 package**：创建本切片确需的 `src/db/web` surface、README 与 manifest；不复制旧 service 或创建空 SDK。
4. **迁移 schema owner**：移动定义时证明无意外 DDL；结构变化按 expand/backfill/switch/contract。
5. **迁移访问控制**：actor-facing 动作经 AccessControl；普通 list 在数据库下推；删除领域内直接读取 member/role 或原始 `resource_context` 的逻辑。
6. **迁移业务能力**：领域规则、事务、引用校验与 side-effect compensation 收敛到新 Facade/Service；调用者只用公开 export。
7. **迁移 route/Web**：交付 `/app` contribution 和资源 `./web`；apps 只留协议聚合与薄 route adapter。
8. **原子切换调用方**：内部 `/web`、后台 caller 和保留 `/api` adapter 同窗口重接新 Facade；验证后删除旧 service/repository。
9. **验收与删除**：运行 contract/route/Web/migration/E2E，确认 import/route/traffic search 为零，再删除旧文件、i18n key 与文档陈述。

协议 ACP/MCP/Webhook/SSE/WS 不因资源切片自动改合同；只调整 owner/DI。外部 `/api` 每个 endpoint 在决定前保持合同，保留者必须重接，改变或删除者等待批准 artifact。详见 [资源、API 与 Web 边界](./resource-api-web-boundaries.md)。

## 4. Stable resource ID 治理

`id` 是资源唯一、不可变、适合 FK/URL/binding/authorization/audit 的标识。`name` 是可修改展示属性，不能用于 get/update/delete/run 或权限判断。需要人类可读地址时可另有受控 slug；名称唯一性由明确 scope 下的 normalized key/constraint 保证，不把 name 升级为 identity。

历史 name CRUD 的迁移顺序：

1. 盘点 name caller、重复数据、URL、payload、默认值、权限记录与所有直接/隐式引用；
2. 沿用已有 stable ID；只有缺失时生成，禁止无必要重编号；
3. 回填关联、route 参数、Web selection、任务 payload、审计与权限引用为 ID；
4. Repository/Service/route 只接受 ID；name query 仅保留搜索或明确 scope/conflict 的导入辅助；
5. 增加必要 FK 与名称约束，修复重复、dangling reference 与 mixed identifier；
6. 切换全部 caller 后删除 name write route/method，不保留兼容转发。

AgentConfig 的 `agent_config.id` 应沿用。Environment ID、Instance ID、ACP session、RCS/YJS doc ID 是不同体系，不能批量字符串替换；Chat URL 中历史 `agentId` 可能实际表示 Environment，必须按数据流逐处核验。

## 5. Ownership、权限与 binding 治理

资源属性与 ownership/authorization metadata 在边界上分离。资源只保存 stable ID 与自身业务字段；AccessControl 独占权限解释。CE 最终存储方案仍见 [CE 授权设计](../ce-access-control-design.md)，迁移时：

1. 盘点现有 organization、owner、visibility、旧权限字段与孤立记录；
2. 在签字后接入统一 create/authorize/list/remove 行为，先删除领域内直接 member/role 与手写授权 SQL；
3. 新增目标权限存储并幂等回填；resource write 与 access initialize/remove 同事务域提交，异构域明确补偿；
4. 比较记录数、ID set、归属、公开/分享和关键列表分页/total；
5. 切换所有 caller 后删除旧权限路径和废弃字段，不长期双写。

AgentConfig binding 的逻辑 owner 由引用方向决定，但 Knowledge/Memory/Site/Environment 的最终物理 table owner 尚由数据 task 决定。被引用资源不反向依赖 AgentConfig repository；删除使用引用保护、显式迁移或动作 owner 编排。Binding replace 必须有事务/并发语义，不能沿用无保护 delete-then-insert。

## 6. AgentConfig 能力簇落位

| current concern | target responsibility | migration constraint |
| --- | --- | --- |
| 配置 service/repository | AgentConfig domain、actor-aware Facade、actor-free Service、repository | 新 package 不调用旧 `src/services/**` |
| 主表与 Skill/MCP/Knowledge/Memory/Site binding | module `./db` 与 owner-approved binding schema | 沿用 stable ID；物理 owner 未决时不复制 table |
| 当前内部 Web route | AgentConfig `/app` route contribution | 新 Web/client 切换后删除对应 `/web` |
| 外部 agents/connect/OpenAI route | external protocol adapter | 逐 endpoint 保持合同并原子重接；改变/删除等 owner 决策 |
| 旧 Agent 页面/client/i18n | AgentConfig `./web` contribution | apps/web 只留 Shell 与薄 adapter；覆盖异步/权限状态 |
| 实例与 orchestration 状态 | Agent InstanceManager | 拥有 ID、quota、registry、start compensation、stop/reuse |
| 多层 LaunchSpec 读取 | 各资源 Domain Service → AgentConfig-owned resolved snapshot | 各边界独立复制；runtime 不回读资源；secret 不落盘/日志 |
| engine/core primitive | Agent runtime + engine provider | 多 provider；保持现有 ACP/relay 权威路径 |

首期依赖能力的唯一矩阵位于 [AgentConfig/runtime detail](./agent-config-runtime-boundary.md)。REF/ENV 提供当前闭环必需能力后，launch assembly 才能消费公开结果；AgentConfig Facade 再完成 CRUD/use/start 编排。MCP inspector、完整 Knowledge ingestion、Site build/deploy/version/proxy、cluster control plane、Chat/YJS/ACP 扩展等没有当前闭环调用证据的能力后置。

## 7. 切换、发布与回滚

每个切片的切换条件：新路径 contract tests 等价；数据 backfill/verify 完成；所有内部 caller 与保留 external adapter 已指向新 Facade；无第二写入口；日志/metrics/audit 可区分 old/new revision；上一版 app 与当前 schema 仍在回滚兼容窗口。

发布顺序遵守 [数据与交付 detail](./data-observability-delivery.md)：DDL → data migration → server/Web → readiness/critical path → traffic。旧路径只有在观测窗口无流量、import/route search 为零、外部消费者已分类、回滚版本可用时删除。

发生以下情况停止并升级：发现未分类 caller/数据引用；新旧写路径并存；迁移无法幂等或补偿；权限/租户/use 语义与签字冲突；真实测试行为偏离基线；外部合同被无授权改变；日志/fixture 可能含 secret；运行 cleanup 状态不可判定。不要用 alias、retry、timeout 扩大或吞错掩盖问题。

## 8. 历史测试治理（原 §13.9）

现有测试若共享模块变量、全局 auth/org context、`process.env`、数据库记录、默认文件目录、Redis/YJS key、端口或外部 mock，文件并行时会相互覆盖。另一类历史债是业务代码暴露 `setXxxForTest()`、reset method 或模块级可变 resolver，导致生产依赖可在运行时被测试改写。

迁移目标是：**业务代码没有测试专用入口；每个 test 拥有独立状态和依赖图；默认文件级并行不共享可变外部 namespace。** 不用全局串行、扩大 timeout 或无边界 retry 掩盖隔离缺陷。

### 8.1 依赖在装配时固定

真实外部依赖通过 constructor/factory 的 dependency object 在创建时注入；纯领域逻辑不为测试增加参数。Apps/server 使用真实 implementations，测试在自己的 fixture 创建同一对象并注入 fake/test repository/clock/ID generator。Fake、fixture 与 test clock 只位于 test utilities，不从生产 package 暴露。

禁止新增：

- `set*ForTest` 或可复位的全局 production export；
- 测试改变模块级 singleton/resolver/callback；
- 业务测试直接使用 module-level mocking 改写其他文件的 import graph；
- 通过 `process.env` 全局 mutation 模拟本应注入的依赖；
- 为了可测试性把 repository/adapter 内部提升为公共 API。

资源之间直接使用公开 Domain Service 的规则不变；依赖创建方式不要求每个方法增加测试参数。

### 8.2 按测试类型隔离

| test type | isolated state | standard approach |
| --- | --- | --- |
| 纯 domain unit | object、clock、ID generator | 每 test 新实例；不访问 DB/env/file/global singleton |
| repository integration | PostgreSQL data/transaction | 每 worker 独立 database/schema；或所有访问都注入 transaction 时每 test rollback |
| app/route integration | app、auth context、dependency graph | 每 test 创建独立 test app；结束关闭 handles/connections |
| Skill/file/archive | temp dirs 与 archive names | 每 test 独立临时目录；不写默认生产目录 |
| Redis/YJS/queue | key/stream/consumer group | 每 test/worker 唯一 prefix，只清自己的 namespace |
| external HTTP/ACP/MCP | fake server/client、port、request records | 每 test 独立实例与动态端口，显式关闭 |

`afterEach` 清共享 database/dir/Redis key 不是隔离：A 的 cleanup 可能删除 B 正在用的数据。必须先建立 namespace，再清理本 namespace。并发语义测试可以在同一个 test 内显式并发，但不借共享全局状态碰运气。

### 8.3 渐进迁移顺序

1. 切片开始前盘点 singleton、test setter、module mock、env、目录、DB/Redis/YJS、端口与未关闭 handle；
2. 在 test utilities 建立该切片的 fixture/test app，创建独立依赖图、唯一外部 namespace 与 cleanup；
3. 迁移测试到 fixture，随后删除对应 production test setter、全局 resolver/callback；
4. DB/file/Redis/YJS tests 在 CI 文件级并行，重复运行以发现顺序污染；
5. 添加守护：禁止新 `set*ForTest` export、业务测试 module mock、默认生产目录写入与 handle leak；
6. 不稳定时修复 ownership/namespace，不串行整组、不扩大 timeout、不加入重试。

AgentConfig 能力簇是首个试点：auth/tenant context、runtime credential resolver、launch assembly、DB binding、Skill dirs、Environment/instance 和 external fake 都必须按该模式隔离。后续资源复用稳定 fixture/namespace 约定，不再创造全局测试开关。

## 9. 分层测试与验收证据

| level | proves | required examples |
| --- | --- | --- |
| domain/unit | 状态机、validation、ID/value 规则 | 无 IO、每 test 新对象 |
| repository/DB | constraint、FK/index、transaction/concurrency、migration | 真实 PostgreSQL 与 tenant datasets |
| route/app | auth short-circuit、DTO/error mapping、Facade wiring | 独立 app/dependency graph |
| runtime seam | authorize/recheck/quota/prepare/start/cleanup 与 lifecycle owner | fake engine/transport，不复制协议栈 |
| Web key flow | loading/error/retry/unauthorized/success、stable ID navigation | browser-relevant interaction + production build |
| upgrade/E2E | 空库/升级库、CE/EE provider、完整 CRUD/run/rollback | fixed revisions、real migration、关键 dependency health |

每个 `test(...)` 上方保留中文行为意图注释；测试优先复用 test utilities。并发、权限、租户隔离、迁移、重连、失败补偿与 secret redaction 必须覆盖关键边界。前端不写纯结构断言或重复类型检查的测试。

### 9.1 基线、重复运行与失败归属

切片开始前固定相关既有 test set、Bun/runtime version、pass/fail/assertion 数、耗时和已知 warning。
目标不是把当前所有实现细节变成合同，而是让行为变化可解释。
新增 contract tests 优先断言公开结果、副作用边界、隔离和资源释放，不锁定 private class 或 exact cleanup 调用次数。

并发污染必须用不同文件顺序与重复并行运行定位。
测试单独通过但全量失败，是共享状态证据，不是增加 retry 或全局串行的理由。
如果全局 gate 的失败与当前切片无关且无法在 allowlist 内安全修复，应保留命令、失败文件和隔离复验结果，单独建任务；不能顺手扩大当前范围，也不能宣称 gate 通过。

Handle/port/process/transaction/temp dir 必须由 fixture owner 释放。
测试结束仍有 timer、server、DB client、child process 或 shared namespace 时即为失败，即使 assertion 已通过。
Fake error 不应携带真实 secret；日志与 snapshot fixture 也执行 redaction review。

## 10. Task truth 与维护债

任务领取、状态、direct prerequisite 与 DB lock 只看协作计划任务总表。协作计划正文可能为了叙述列出传递前置，而总表未列；这是计划维护债，不能由本文复制一个新 DAG 来“修正”。当 owner 正式改变任务依赖时，直接修改权威总表并说明原因。

ARC-02 不做协作 bookkeeping，也不创建未决定事项的 ADR。每个后续 task 在自己的计划中列出文件、权限/租户、数据、并发/失败、测试、观测、发布与回滚；实现结果若需要改变已签字公共契约，先走 architecture/EE-C review，不能在代码中静默偏离。
