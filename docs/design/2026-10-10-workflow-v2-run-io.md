# Workflow V2：运行日志「出入参数」读路径（主从两栏）

- **日期**：2026-10-10
- **提出方**：FenixAgent 控制台（`workflow-v2` 模块）；需求原文是「运行记录里能看到这次运行的出入参数」
- **目标**：在上游工作流引擎（opencoze / workflow-studio）不提供运行级 input/output 的现状下，
  让控制台的运行日志能按需查看某次运行的输入与输出
- **状态**：**已落地**——服务端 `GET /web/workflow-v2/run-records/:executeId/io`（按选中项取一次）+ 运行日志
  弹窗的主从两栏（左栏按执行 ID 列运行、右栏看选中项的输入与输出）；契约与映射见
  `services/workflow-run-io.ts` 文件头
- **关联**：[运行日志清单契约](./2026-10-09-workflow-v2-upstream-run-list-api-request.md) §7（`list_spans`）、
  [契约快照](./2026-09-29-workflow-v2-upstream-contract-snapshot.md) §2 第 16 行（`get_process`）、
  架构 [25-workflow-v2](../arch/25-workflow-v2.md) §8「运行日志」

## 1. 结论

**运行级出入参数在上游不存在，它只能由节点级结果合成**：运行输入 = Start 节点（`NodeType="Start"`）的
`input`、运行输出 = End 节点（`NodeType="End"`）的 `output`（空串时回退 `raw_output`）。数据源是
`GET /api/workflow_api/get_process`（会话面），**运行结束后仍可查**，因此覆盖历史记录而不只是运行中轮询。

界面形态是**运行日志弹窗内的主从两栏**：左窄栏按执行 ID 列运行记录，选中一条（打开时默认选中第一条）即在
右宽栏看它的输入与输出；出入参数按选中项单独取一次。不新增详情页、不改清单端点——清单接口 `list_spans`
按契约不回 input/output，给整页列表补 N 次上游查询不成立。

## 2. 数据源选型（备选与排除理由）

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| `GET /api/workflow_api/get_process`（会话面） | **采用** | 回节点级 `nodeResults`（含 `input`/`output`/`raw_output`）；实测终态运行仍可查 |
| `list_spans`（清单在用） | 排除 | 契约明确不回 input/output（[run-list-api-request](./2026-10-09-workflow-v2-upstream-run-list-api-request.md) §4） |
| `GET /v1/workflow/get_run_history`（PAT 面） | 排除 | 需要另一套凭据（PAT 面的定位是对外触发，见 [api-channel-release](./2026-10-09-workflow-v2-api-channel-release.md)），而会话面已够用 |
| `GET /api/workflow_api/get_node_execute_history` | 排除 | 单节点粒度、要 `node_id`+`node_type`，看整次运行需要先知道图里有几个节点 |
| `GET /api/workflow_api/get_trace` | 排除 | 该构建仍为桩实现（恒回 `{}`），见契约快照 §2 第 15 行与其 §「已结案」备注 |

## 3. 上游实测（2026-10-10，本地上游只读探针）

样本：Start→End 空图的一次 `test_run`（终态 `executeStatus=2`，`code=0`）。

- `data.nodeResults[]` 元素 13 个字段：`nodeId` / `NodeType` / `NodeName` / `nodeStatus` / `errorInfo` /
  `input` / `output` / `raw_output` / `nodeExeCost` / `tokenAndCost` / `errorLevel` / `logVersion` / `extra`；
  `input` / `output` 是 **JSON 序列化字符串**。
- **`NodeType` 回的是类型名**（`"Start"` / `"End"`），不是 schema 里的 `"1"` / `"2"`——匹配必须按名字。
- 运行级另有 `logID` / `workflowExeCost` / `tokenAndCost` / `rate` 等；**没有**运行级 input/output。
- 端点**只挂 GET**（POST → HTTP 404 `not found`，见契约快照 §2 第 16 行与 A8 行）。

负例（同一探针，全部只读）：

| 输入 | 上游返回 | 含义 |
| --- | --- | --- |
| `execute_id` 不存在（workflow 真实） | HTTP 200、`code=0`、`data.nodeResults=null`、`executeStatus=1` | **不是错误**：返回一个空壳，平台侧因此只能给 null（界面显示「上游未提供」） |
| `workflow_id` 不存在 | HTTP 200、`code=0`、`nodeResults=null`，且 **`workFlowId`/`executeId` 原样回显请求值** | 上游**不校验** workflow 与 execute 的归属；参数只被回显 |
| 缺 `execute_id` | `code=777777775`（panic），`msg` 是 Go 堆栈 | 参数校验缺失，缺参即 panic——这就是 `upstreamFailure` 必须剥离 panic 原文的原因 |
| 只传 `log_id`（以 `execute_id` 键传） | 同上 panic | 修正契约快照「`execute_id` 可换 `log_id`」的口径：**本构建不认 `log_id`**，必须带 `execute_id` |

## 4. 平台侧契约

`GET /web/workflow-v2/run-records/:executeId/io?upstreamWorkflowId=<上游 ID>`

- `upstreamWorkflowId` 取**上游 ID**（= 运行记录条目里的 `workflowId`），与清单端点的 `workflowId`
  （本地主键）是不同的参数名：两套标识混用会查不到或查错，刻意不共用名字。
- 前置链与清单同表：未认证 401 → 未绑定 409 → 未登记/跨组织 404（同形，不泄漏存在性）→ 上游失败
  502/503/504。响应 `{ input, output }`，两段均可为 null。
- 请求口径：只送上游声明的三个 query（`workflow_id` = 注册表里的上游 ID、`space_id` = 绑定行、`execute_id`
  = 路径参数），方法恒 GET；键集完全相等由用例钉住。
- 界面：按选中项取一次——右栏看到哪一条就取哪一条（`executeId` 与 `upstreamWorkflowId` 缺一的记录不可选中）、
  重复点同一条不重复请求、右栏错误 + 右栏重试（不升级成整页错误，也不重取整个清单）。

## 5. 已知边界与残留风险

1. **归属校验只到平台侧**：上游不校验 `execute_id` 是否属于该 workflow（§3 负例），因此
   「本组织 workflow + 他组织 execute_id」这一构造在上游会被照常返回。风险受限的依据：execute id 只在本
   组织的运行记录里可见，且调用方无法用本地主键拼装上游 ID（`findWorkflowByUpstreamId` 只认本组织已登记
   的 `upstream_workflow_id`）。**移除条件**：上游按 execute id 查询时校验「该运行属于请求的 workflow」，
   或平台侧改为「先按 `list_spans` 校验该 execute 出现在本 workflow 的窗口内再取详情」（代价：每次查看某条
   记录的出入参数都多一次清单调用）。
2. **运行记录保留期未验证**：本地没有早于 7 天的运行样本，无法判定 `get_process` 对过期运行的行为。终态
   运行可查（§3）说明它是库侧读取而非内存快照，但保留策略未知。**验证条件**：在真实环境用一条超过 7 天的
   运行记录试读一次；若返回空壳，界面显示「上游未提供」，与「这次运行确实没有输入输出」同形。
3. **`nodeStatus` 语义未消费**：只确认了成功态 `nodeStatus=3`；失败运行下 Start/End 节点是否仍回
   input/output 未实测。当前实现不看状态、只取值——失败运行若能取到输入，对排查反而更有用；取不到即 null。
4. **节点调试运行**（`mode=node_debug`）通常只有单个节点：Start/End 缺一即 null，不拿别的节点顶替。

## 6. 验证

- 服务端：`src/__tests__/workflow-run-io.test.ts`（挂载、请求键集、取值与回退、404/409/502/503/504 各档）。
- 前端：`web/__tests__/workflow-run-log-model.test.ts`（行模型、左栏选中解析与格式化）、
  `web/__tests__/workflow-run-log-dialog.test.tsx`（按选中项只取一次、重复点同一条不重复请求、在途加载态、
  右栏失败与重试、缺归属要素不可选中）、`web/__tests__/workflow-v2-i18n.test.ts`（字典完整性）。
- 探针（只读、本地上游）：`get_process` 的形状与负例结论见 §3；临时工作流探针用完即删，未留残留。
