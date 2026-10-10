# ADR: 运行日志的「上游执行列表」改为平台只读直连上游库（**已废弃**）

- **日期**：2026-10-09
- **状态**：**已废弃（从未启用）**——上游已于同日以 commit `3a028cf1` 实现 `POST /api/workflow_api/list_spans`
  （原桩端点补实现），本 ADR 的「移除条件」达成，方案实现（只读适配器、五枚 `WORKFLOW_V2_UPSTREAM_DB_*` 配置、
  运维文档与相关测试）**已整体删除**，运行列表切回 HTTP。本文只作为决策记录保留。
- **关联**：架构 [25-workflow-v2](../arch/25-workflow-v2.md) §7、需求与交付回执 [上游运行历史列表接口](../design/2026-10-09-workflow-v2-upstream-run-list-api-request.md)、契约快照 [2026-09-29](../design/2026-09-29-workflow-v2-upstream-contract-snapshot.md)（29/29b/29c 行）

## 背景

控制台「运行日志」需要列出某个工作流的历次运行。上游把每次运行落进 `workflow_execution`（含 execute id、
workflow id、space id、mode、status、duration、created_at、error_code、node_count、log_id、commit_id 等列），
**数据真实存在**；但 2026-10-09 的穷尽核对确认它**没有可列举的 HTTP 读出口**：

- `POST /api/workflow_api/list_spans`、`POST /api/workflow_api/get_trace` 在当前关联构建里是**桩实现**
  （`backend/api/handler/coze/workflow_service.go:630` / `:646` 只做参数绑定后返回空结构体）；
- `GET /api/workflow_api/get_process`、`GET /api/workflow_api/get_node_execute_history`、
  `GET /v1/workflow/get_run_history` 都是**按 `execute_id` 取单次**（不带 id 直接 panic）；
- `history_schema` 需要 `commit_id` 且回的是画布快照；`store_testrun_history` 在该构建**没有路由**；
- 上游前端也只有一个执行相关的列表控件（trace 选择器），它调的就是上面那个桩 —— **上游自己的界面同样列不出来**。

因此「运行日志」此前只有两种选择：显示空（用户以为平台丢了数据）或等上游补齐接口。用户拍板第三条路：
**平台以只读身份直连上游库取列表**。

## 决策

1. 运行日志的**执行列表**改由平台直连上游 MySQL（`workflow_execution`）读取：只读连接、只查列表需要的列、
   `space_id` + `workflow_id` + 根执行三重过滤、`created_at DESC, id DESC` 排序、`LIMIT` 有界。
2. **详情仍走上游 HTTP**：`get_process` 等既有端点与行为不变（点开某次运行去上游调试页的那条路没有改动）。
3. 连接参数是**离散键**（`WORKFLOW_V2_UPSTREAM_DB_{HOST,PORT,USER,PASSWORD,NAME}`），密码单独标 `secret`；
   未配置 USER/PASSWORD 视为**未接入**（显式状态，不是失败、也不伪装成空列表，多部署口径下不阻塞启动）。
4. 读取失败**不返回空列表**：列表这一段用 `itemsState = ok | not_configured | failed` 表达三种情况，
   界面各自给文案；不与平台侧记录段互相污染。

## 为什么是可接受的（与既有约束的关系）

- **存储与平台同机**：上游服务、库与平台部署在同一台机器（上游默认 `127.0.0.1:18080` / `3306`），
  直连不引入跨网络的数据面，也不需要把库暴露到公网。
- **只读、最小权限**：只允许 `SELECT`（授权 SQL 见运维文档），平台不改上游数据、不建表、不建账号。
- **列取最小**：`input` / `output` / `fail_reason` 这类运行原文**不进查询**——它们既不进响应也不进日志，
  要看详情走上游调试页。
- **有明确退场路径**：这一步是「上游缺读出口」的权宜，不是长期架构。

## 被否方案

| 方案 | 结论 |
| --- | --- |
| 只显示平台自己触发的运行（审计留痕） | ❌ 只覆盖外部接口触发的运行，画布内的试跑看不到；用户要的是「这个工作流跑过什么」 |
| 等上游补齐 `list_spans`（保持纯 HTTP） | ❌ 当前构建没有时间表；数据已在库里，用户明确要求先能用 |
| 平台侧落一份自己的执行台账 | ❌ 与「运行记录只放上游」的既有口径冲突，且要新增表与迁移；直连是只读、无第二份真相 |
| 用 `get_process` 逐条探测 execute id | ❌ 没有 id 来源，无法枚举 |

## 代价与风险（部署方需知情）

1. **上游表结构不是公开契约**：列名/语义随上游升级可能变化。缓解：只依赖展示所需列；行映射是纯函数并有单测；
   读失败有显式状态与日志（不静默降级成空）；契约快照记录了本次实测的列清单与样本。
2. **根执行的表示在上游实现里不统一**（该判定随本方案一起删除；上游 HTTP 实现用 `parent_node_id IS NULL OR = ''` 判根）：`entity/workflow_execution.go` 的字段注释说「根执行为 NULL」，
   而实现（`workflow_run.go:272`）把根执行的 `root_execution_id` 设成**自身 id**（本机 38 行样本全是这一形态）。
   平台按三种形态都认（自引用 / NULL / 0），SQL 与行映射各判一次。
3. **账号与网络可用性**：库不可达时列表段是 `failed`（不是空列表），平台侧记录段照常显示。
4. **权限扩散风险**：只读账号应限定到 `opencoze.workflow_execution`（与 `node_execution`）两张表；
   不得给全库 `SELECT`。

## 移除条件

上游发布「列出某个工作流运行」的 HTTP 接口（`list_spans` 补实现，或等价的列表端点）后，**改回 HTTP**：
`services/workflow-run-records.ts` 换成该端点的读法、删掉本适配器与五枚 env，运维文档同步删除只读账号。

## 隔离与最小权限措施（本次落地）

- 连接参数离散配置，密码 `secret: true`；日志只记 `host:port/database`，失败原因经
  `redactConnectionText()` 脱敏（抹掉 `user:pass@` 与 `password=…` 形态）并截断；
- 惰性连接、跨请求复用、池上限 2、查询 3s 预算（超时即关连接，避免卡死连接复用）、无重试；
- 多租户纵深防御：查询固定带 `space_id`（绑定里的平台空间，来自服务端，客户端不参与），
  行归属用 `workflow_id` 回收；
- 响应与日志都不含运行原文与凭据（有单测钉住）。
