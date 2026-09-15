# CE 阶段 1：现有功能物理迁移执行计划

> **给执行智能体：** 本文件是阶段 1 的唯一执行计划；目标物理目录与 owner 只读[目录结构与归属说明](./ce-ee-engineering-directory-structure.md)。除此之外，仅需阅读当前代码、对应测试及必要的就近开发规则；**不需要阅读目标权限、API 或架构开发规范**。目录说明不能覆盖本文件的“原样保留”要求。不得按未来目标修改现有业务；文档中的文件示例仅用于搜索定位，每个闭包以真实源码和引用图确认归属。

**目标：** 在已有 workspace 与 `apps/server`、`apps/web` 入口基础上，把根 `src/`、`web/` 中的所有业务和共享实现迁到 `apps/`、`packages/` 等最终目录。只做维持旧功能所需的路径和接线修改。整个阶段最后一个提交可上线；中间提交允许记录暂时失败的检查，不添加过渡逻辑。

## 1. 唯一合同：搬位置，不改行为

1. 原 HTTP/WS 路径、method、headers、query、body、错误码、响应字段、身份认证顺序和组织上下文保持**逐项相同**。既有 `/web/*`、`/api/*`、ACP、MCP、hooks、文件、下载和静态资源合同原样可用，包括现有 name/ID 和 action 风格；不新增、更名或删除对外接口。
2. 原 service、repository、路由内部判断、存储/文件处理、定时任务、Chat/YJS、Workflow、Instance 和 Sandbox 的行为、控制流、并发、释放时序保持相同。权限继续由各处原有逻辑处理，包括 `resource_permission`；不让旧业务改用新授权实现。Provider 和 Model 物理归**同一个 `model` 包**，Model 作为 Provider 下级继续按 Provider 的原权限逻辑判断。
3. 表、字段、索引、存量数据、Drizzle SQL、meta/journal、data migration 内容与执行顺序完全不变；schema 源码移动必须得到零 DDL 差异结果。不得生成用于改变现有库的 SQL，也不增删权限记录。
4. 前端原页面、Environment 操作流程、文案、i18n key、URL、样式、loading/error/retry 与静态资源保持原样。移动到包内并不授权将前端的流程改为后端流程，也不授权重写模型网关预算所需的 `organizationId` 等参数。
5. 除 import、包 exports/依赖声明、测试路径、构建/部署引用、应用装配的**必要路径适配**外，不增加框架、通用算法、临时 shim、双写或第二套业务实现。不能为了通过新目录的理想依赖图而改变原有权限或调用顺序；若机械迁移确实遇到循环依赖、职责冲突或需要明显新增逻辑，先保留现状、说明具体引用与替代落点，等待范围确认。

Review 判断的优先级是：**当前生产源码及原测试展示的行为 > 本文件的目录归属 > 目标架构设计中的未来接口**。发现旧业务本身不符合新规范，只记为非本阶段事项；若原代码有现存风险，不以物理迁移为由顺手修复。涉及新的公共协议、职责和数据流，编码前反馈确认。

## 2. 目录落点与归属判定

新架构的完整目录树、包内子目录和归属规则以[目录设计](./ce-ee-engineering-directory-structure.md)为准；下表仅用于回答“**现有文件如何从旧位置搬到新 owner**”，这是阶段 1 的实施映射，不是目录设计的新规范。

| 当前实现 | 物理移动的落点与约束 |
| --- | --- |
| `apps/server/src/` 的既有入口与组装 | 保留在 `apps/server`；旧 `src/` 中 app 专属启动、认证插件、HTTP/WS 协议入口以及服务关闭接线迁到宿主或实际业务包的 route，现有启动顺序不改 |
| 根 `src/services/`、`src/repositories/`、`src/routes/`、`src/schemas/` 的领域实现 | 同一功能的业务规则、数据访问、校验、后端 route contribution 放在 `packages/resources/<业务包>/`，原协议 prefix 仍由宿主按旧位置挂载；无领域 owner 的宿主协议及共享平台能力分别在 `apps/server` / `packages/platform` |
| Environment、Instance、Agent runtime 组合 | `packages/agent-runtime`；已经在 `packages/core`、`packages/orchestration`、`packages/chat-channel`、`packages/remote-runtime` 的实现继续归各自包，不复制或合并 |
| Provider 与 Model | `packages/resources/model` 一个包，Model 是 Provider 二级资源；已有 `packages/model-gateway-*` 继续持有它们原有的网关 adapter，不把预算业务逻辑挪到无关 owner |
| 根 `src/db/` 与 `drizzle/` | DB 连接/运行宿主接线、schema 的唯一声明及生成迁移产物归 `apps/server` / 仓库 `db/` / 实际所属资源包；迁移产物若移动到 `db/migrations/`，只改运行引用，SQL/meta/journal 字节及顺序必须不变；不能留下重复 schema 或重复迁移入口 |
| 根 `src/__tests__/`、`src/test-utils/` | 随被测闭包进入包内 `src/__tests__/` 或 `apps/server/src/__tests__/`，共享测试工具落在真实共同 owner；`scripts/__tests__/` 不因为目录清理丢失 |
| `apps/web` 的现有入口 | 保留在 `apps/web`；根 `web/src/routes/` 的薄路由适配和全局壳/API request/i18n 初始化、`web/components/` 通用 UI、全局 CSS、`web/public/`、前端测试基础设施分别归 `apps/web` 或已有共同 owner |
| 根 `web/src/pages/`、领域 API/i18n、领域组件 | 随同一业务闭包落在该包的浏览器专用 `web/` 子路径；`apps/web` 只接原页面路由。浏览器模块不能因为新 export 引入服务端依赖；生成的 routeTree 仅靠工具重生，不手工编辑 |
| 根 `scripts/`、Dockerfile、deploy/docker、Vite、TS/CI/Drizzle 配置 | 仓库薄命令、镜像和配置仍由对应入口持有；仅替换已搬迁文件的路径、别名、COPY、测试扫描和生产挂载引用。现有根 `src`、`web` 路径被清空后，构建与镜像不可再引用它们 |

目标包结构只要求承接**实际存在**的文件和公开的旧调用出口，不要求为每个包预造新 DTO、权限 Facade、module contribution、表扩展或页面框架。一个旧文件由一个最终 owner 持有；被多个功能使用的旧能力先决定真实共享 owner，并由调用包引用同一份实现，不复制。迁移期间根目录可保留尚未迁走的其他闭包源码，但最后必须完全清空。

## 3. 每个闭包的实际实施流程

每次只领取一个下表任务。开始前用 `rg --files`、`rg -n` 盘点该闭包的旧 route/service/repository/schema、后端和前端调用方、UI/i18n、后台作业、专项测试、DB 与构建引用；检查原源码和测试真实行为。把路径归属清单、**必做项/不做项**、旧接口样例、删除源文件的条件写在该任务的 review 记录里，不提前为其他闭包改造接口。

1. 先跑最小的旧专项测试或静态协议检查，留下搬迁前的基线；如原测试本就失败，记录命令、失败证据和能否无损迁移，不能谎称原先全绿。
2. 使用源文件移动并仅修改必要引用、包依赖/exports、路径配置和宿主接线；保持原函数、协议、状态机与测试断言，不创造中间版本适配。路由从旧位置移动后原 HTTP 路径仍须由新位置原样挂载。
3. 运行该闭包最小专项测试与 typecheck/build；比较搬迁前后的参数、响应、权限、SQL、日志及前端状态。任何差异先按真实链路诊断并恢复原行为，不把差异解释为未来规范。
4. 进行规格 review 和代码质量 review，修复当前合同、验收或安全红线问题后再次 review，直至没有必须修复项。仅供以后治理的建议写入 review，不在本次实现。每轮 review 文档留在工作区、不暂存、不提交，供用户验收后自行删除。
5. 仅在源文件已完整迁移且旧位置 import/运行入口搜索为零时删除源文件。每个闭包提交**一次**，提交范围只包含当前闭包的物理搬迁、必要接线与测试路径；保留 commit ID、文件映射、专项检查和中间失败的具体原因。对中间提交不强制跑全仓完整 precheck，不因临时未全绿建立兼容实现。

## 4. 现有功能闭包任务池

一个编号对应一个提交；编号顺序是初始共享能力安排，PHY-03 至 PHY-09 应按**实际引用**决定可执行顺序。某些现有调用链确实不可分时，先说明具体依赖、调整任务边界并经确认后再实施，不能用临时双栈掩盖。每个闭包同时处理既有后端、前端和测试，不能按 route/service/UI 分层拆提交。

| Task | 需要完整迁移的现有闭包 | 必须对照的现有性质 |
| --- | --- | --- |
| PHY-01 | 认证、组织上下文、env、DB/schema 唯一声明、请求上下文、后台宿主公共依赖及后端测试工具 | Cookie → Environment Secret → API Key 的原认证顺序、active-org 来源、事务/迁移顺序；`src/db/schema.ts` 搬移无 DDL |
| PHY-02 | Web 壳/导航、路由薄适配、API request、通用 UI、i18n 初始化、全局 CSS/静态资源、浏览器公共测试工具 | `apps/web/vite.config.ts` 中旧 `web/` routes/alias/public 引用按新位置替换，路由树生成、请求解包与原 UI 保持一致 |
| PHY-03 | Environment、持久 Instance、Agent runtime 协调/进程、ACP relay、YJS Chat 宿主组合及其相关路由/测试 | `src/services/environment-web.ts`、`src/services/agent-instance-*`、`src/transport/` 的现有时序；前端 Environment 与现有 YJS 入口不得改变 |
| PHY-04 | Provider/Model 同一业务包、模型网关管理及预算/凭证/用量的既有后端、前端、后台接线和测试 | 继续通过 Provider 权限决定 Model 访问；网关预算参数、凭证隔离、原 `/web` `/api` 返回不变 |
| PHY-05 | Skill、MCP、知识库/RAG、记忆/Hindsight 各自现有管理、运行解析、文件/数据、页面和测试 | Skill 元数据/源文件/归档三段写入、原 MCP 前缀、Knowledge 服务行为不变 |
| PHY-06 | AgentConfig、模板、配置绑定/选择器、Site App、站点发布及实际业务引用 | `src/routes/web/config/agents.ts` 的旧 action/name 行为、外部 Agent 接口、旧页面及 bindings 不变 |
| PHY-07 | Machine、Sandbox、workspace/file、本地/远端执行和相关 WS/协议入口及测试 | 原路径越界校验、断连、Machine fencing、Sandbox 分配和释放时序不变 |
| PHY-08 | Workflow、Scheduler、任务/Webhook、Channel/Chat 的现有管理、触发、节点执行、页面和测试 | 当前 session selection、instance lease、幂等及失败取消规则不变 |
| PHY-09 | 组织、API Key、系统管理、Observer、ProdView、branding 及尚未覆盖的其他**完整业务闭包** | 原认证/权限和所有管理页面可用；盘点剩余实际文件，不把业务迁移推给 PHY-10 |
| PHY-10 | 全仓路径、仓库脚本、CI/TS/Drizzle/Vite/Docker/Compose、生产 server/web 交付引用的最终收口 | 根 `src/`、`web/` 无文件/引用；Dockerfile 当前对旧 server build 路径和前端 dist 的 COPY 等应指向新真实产物，不改启动流程 |

若现有文件跨两个任务共用，按**唯一实际 owner**归入首次能够承接其完整行为的任务，其他任务只更新自己的调用引用。PHY-10 不允许承接尚未迁移的业务功能。新增包的名称和落点通过当前目录职责确认，不能把 Provider/Model 拆成两个包，也不能因为业务闭包多而复制既有基础包代码。

## 5. 最终统一验收与证据

只在所有闭包及路径收口完成后执行完整全仓验收；每项失败须诊断、修复并重跑直至全绿。留下**未提交**的 `e2e.md`：记环境与历史数据来源（不含密钥）、前后版本和 commit ID、命令、实际结果、失败修复与复测证据；每轮未提交 review 文档留给用户检查。

| 验收对象 | 必须证实的结果 |
| --- | --- |
| 目录与唯一实现 | `rg --files src web` 没有旧根目录文件；全仓旧目录 import/build/deploy 引用为零；无重复 service、route、DB schema 或静态资源副本 |
| 静态与全仓测试 | `bun run precheck` 全绿，完成后前后端被搬迁的所有相关测试、脚本测试和包测试可运行；CI/test 扫描配置覆盖新路径，warning/error 不新增 |
| 前端生产产物 | `bun run build:web` 通过；真实生产静态挂载地址、路由与 Web asset 请求正常；浏览器端没有加载服务端包内模块 |
| 后端生产产物 | 用当前 Dockerfile/实际发布脚本构建 server 镜像并启动；保留原 initDb → 原 data migration → builtin、网关、Core、scheduler 等顺序及停机释放；镜像不 COPY 或执行不存在的旧根文件 |
| 数据库 | 空库与按真实历史迁移链创建的已有库均可初始化与运行；schema diff 无 DDL、旧 SQL/meta/journal 字节与执行顺序不变，现有数据保持原状 |
| 合同与权限 | 旧 `/web`、`/api`、ACP/MCP/hooks/WS、Environment CRUD、Provider/Model 与网关预算、组织/角色/资源访问的请求和响应逐项与迁移前一致；跨组织隔离仍正确 |
| 端到端 | 新 server/web 入口真实启动，登录/组织、Agent 配置/启动/Chat、Provider/Model、Skill/MCP/知识、Machine/Sandbox/file、Workflow、任务、Site/Observer 等既有关键用户流程与失败/重连场景全绿；可上线 |

不存在“本阶段先只完成 AgentConfig 最小闭环”的验收方式。阶段最终的版本必须包含原根目录中**全部**功能；中间闭包暂时失败的检查只允许在确切记录且最终修复全绿的前提下保留在历史提交里。上线决定和验收资料由用户审阅，执行智能体不得自行扩大为修改生产数据或发布。
