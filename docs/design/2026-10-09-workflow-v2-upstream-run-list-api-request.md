# 上游需求：工作流运行历史列表接口（`list_executions`／补全 `list_spans`）

- **日期**：2026-10-09（同日追加交付回执：§7 契约、§8 对接指引、§9 验收对照）
- **提出方**：FenixAgent 控制台（`workflow-v2` 模块）
- **目标**：上游工作流引擎（opencoze / workflow-studio）；需求提出时核对版本 `main@60046529`，
  交付核对版本 `main@cd796ef9`（2026-10-09）
- **状态**：**已交付并已对接**——上游以「补全原有 `list_spans`」而非新增 `list_executions` 的方式落地
  （**commit `3a028cf1`，2026-10-09**；`ea43584a`、`cd796ef9` 补用例）；**平台侧同日已按 §5 的移除条件切回 HTTP**：
  删除只读直连适配器与 `WORKFLOW_V2_UPSTREAM_DB_*` 五枚配置、恢复 `list_spans` 读路径（映射与失败语义见
  `services/workflow-run-records.ts`）。
- **总体结论（交付核对）**：上游列表接口现已可用，平台侧可开始切换；但 `get_trace`（`GetTraceSDK`）**仍是空壳**，
  选中某次执行后的 trace 树/详情仍为空（属另一需求，见 §9.2）

## 1. 需求一句话

控制台需要「按工作流列出历史执行」的能力（时间、模式、状态、耗时、节点数、错误码），目前上游**数据已落库但没有任何列表读出口**。

> **更新（2026-10-09 交付核对）**：上游当晚补齐了该读出口——§2.2 记录的桩实现已被替换（提交 `3a028cf1`）。
> 实际交付形态与本文 §3 的建议有差异（沿用原端点、扁平响应、offset 分页，且没有 `space_id` 请求字段），
> 以 §7 的契约为准。

## 2. 现状与证据（2026-10-09 只读实测）

**2.1 执行记录已落库，数据完整**

- 表 `workflow_execution`（注释：「workflow 执行记录表，用于记录每次 workflow 执行时的状态」），字段含
  `id`(execute id)、`workflow_id`、`space_id`、`version`、`mode`(1 调试/2 发布运行/3 节点调试)、
  `status`(1 running/2 success/3 fail/4 interrupted)、`duration`、`created_at`、`error_code`、
  `node_count`、`log_id`、`root_execution_id`、`commit_id` 等，索引
  `idx_workflow_id_version_mode_created_at (workflow_id, version, mode, created_at)`。
- 节点级明细在 `node_execution`（按 `execute_id` 关联）。
- 实测样本：workflow `7694581096108785664` 有 3 条成功执行（`mode=2`、`status=2`、`duration` 9/18/10 ms），
  其 `execute_id=7694582493076258816` 的 `node_execution` 有 2 行。

**2.2 列表读出口不存在（三个层面交叉印证）**

| 层面 | 事实 |
| --- | --- |
| IDL | `idl/workflow/workflow_svc.thrift` 里带「列出历史执行」语义的只有 `ListRootSpans`（注释原文 `// List traces of historical execution`，`POST /api/workflow_api/list_spans`）与 `GetTraceSDK`（`/api/workflow_api/get_trace`）；其余真实端点（`GET /api/workflow_api/get_process`、`GET /api/workflow_api/get_node_execute_history`、`GET /v1/workflow/get_run_history`）**都要求 `execute_id`**，只能按 id 查详情 |
| 实现 | 该构建里两个 trace 端点是**桩**：`backend/api/handler/coze/workflow_service.go:630` 的 `ListRootSpans` 与 `:646` 的 `GetTraceSDK` 只做参数绑定后 `c.JSON(200, 空结构体)`，应用层无对应实现 |
| 实测 | 带 3 次真实成功执行的 `workflow_id` + 覆盖其 `created_at` 的时间窗请求 `list_spans`，恒回 `{"spans":null}`；`get_trace` 恒回 `{}` |
| 上游前端 | trace 选择器（`frontend/packages/workflow/test-run-next/trace/src/components/trace-select/use-options.ts`）调用的正是 `workflowApi.ListRootSpans` ——**上游控制台自己也列不出历史执行**，与本需求同一个根因 |

> **已过时（2026-10-09 18:37 起）**：上表「实现」一行只适用于需求提出时的构建。`ListRootSpans` 已实现
> （handler `backend/api/handler/coze/workflow_service.go:632` → 应用层 `backend/application/workflow/workflow.go:852`）；
> `GetTraceSDK` **仍为桩**（同文件 `:663`，仍是 bind 后返回空结构体）。
> 「IDL」一行不变；「上游前端」一行的事实不变（前端确实调该端点，本次交付前端零改动），
> 但「列不出历史执行」的结论随实现落地已不成立。

**2.3 影响**

- 上游自身「历史执行 / trace 列表」相关 UI 在该构建下不可用；
- 任何以 HTTP 集成的下游（本平台、外部调用方）都拿不到执行列表，只能自行落库或直读数据库。

> **已消除（2026-10-09）**：列表这一段两条影响均已由 §7 的接口解决；「点开某次执行的 trace 详情」仍不可用
> （`get_trace` 未实现），详见 §9.2。

## 3. 期望接口（建议，命名可由上游裁定）

```
POST /api/workflow_api/list_executions        # 或按原设计补全 list_spans
{
  "workflow_id": "7694581096108785664",       # 必填
  "space_id": "…",                            # 建议必填，服务端仍按成员关系校验
  "start_at": 1791534000000,                  # 可选，毫秒
  "end_at":   1791535000000,                  # 可选，毫秒
  "status":   [2, 3],                         # 可选：1 running / 2 success / 3 fail / 4 interrupted
  "mode":     [1, 2],                         # 可选：1 调试 / 2 发布运行 / 3 节点调试
  "limit":    20,                             # 默认 20，上限 50
  "page_token": "…"                           # 可选，游标
}
→ 200
{
  "code": 0, "msg": "",
  "data": {
    "executions": [{
      "execute_id": "7694582493076258816",
      "workflow_id": "7694581096108785664",
      "version": "v0.0.2",                    # 草稿为空串
      "mode": 2, "status": 2,
      "duration": 9,                          # 毫秒
      "created_at": 1791534594524,            # 毫秒
      "error_code": "", "node_count": 2,
      "log_id": "…"
    }],
    "next_page_token": "…"                    # 无更多时为空
  }
}
```

**约定**

- 鉴权与 space 隔离沿用现网口径（session/space 成员校验），调用方不应能跨 space 列举；
- **排除子流程执行**（`root_execution_id IS NULL`）；
- 排序 `created_at DESC, id DESC`，游标分页在新执行持续写入时保持稳定；
- 列表**不回传** `input` / `output` / `fail_reason`（运行原文与错误堆栈属详情面，由 `get_process` 承担）。

**与实际上线契约的差异（2026-10-09 交付核对）**

| 本节建议 | 上游实际交付 |
| --- | --- |
| 新端点 `POST /api/workflow_api/list_executions` | 沿用原端点 `POST /api/workflow_api/list_spans`（同一 IDL 端点补实现） |
| `space_id` 建议必填 | **无该字段**：服务端由 `workflow_id` 反查工作流 meta 取 `space_id`，再按 space 成员关系校验 |
| `status` / `mode` 数组 | 单值：`status`（0–5）与 `execute_mode`（0–3），`0` 表示不过滤 |
| `page_token` 游标 + `next_page_token` | **无**：只有 `limit`（默认 20，上限 50）与 `offset` |
| `data.executions[]` 包一层 | **顶层扁平**：`{code, msg, spans}`（上游前端拦截器要求顶层 `code===0`，选择器在顶层解构 `spans`） |
| 排除子流程执行（`root_execution_id IS NULL`） | 同等语义、不同判定列：`parent_node_id IS NULL OR parent_node_id = ''` |

## 4. 验收标准

1. 对同一 workflow 的 3 条历史执行能一次列出，字段值与 `workflow_execution` 一致；
   → **已覆盖**（明细见 §9.1 第 1 条）
2. 时间窗、状态、模式过滤生效；分页稳定（分页期间新增执行不改变既有页结果）；
   → **过滤与排序已覆盖；「分页期间新增」不成立**（offset 分页无游标，见 §9.1 第 2 条与 §9.2）
3. 跨 space 请求被拒绝；
   → **已覆盖，但返回形态是 HTTP 200 + `code=777777775`**（不是 4xx，见 §9.1 第 3 条）
4. 上游自身 trace 选择器恢复可用（同一根因的回归验证）。
   → **上游前端无需改动；待人工回归**（启动方式见 §9.3）

> 上述条款的完整对照与证据（含各层测试名、命令）见 §9。

## 5. 平台侧过渡与切换条件

上游接口就绪前，FenixAgent 采用**只读直连 `workflow_execution`** 的过渡方案（见本仓 ADR
`docs/adr/2026-10-09-workflow-v2-upstream-db-read.md`，含最小权限与隔离措施）。该 ADR 记录：上游实现本需求的
列表接口后，平台把读路径切回 HTTP 并移除数据库直连——届时本需求即该过渡方案的移除条件。

> **移除条件已满足（2026-10-09）**：§7 的接口就是 ADR「移除条件」所说的「`list_spans` 补实现」。
> 平台侧可执行切换：读路径换成该端点，并按下文删除只读适配器与 `WORKFLOW_V2_UPSTREAM_DB_*` 配置
> （ADR 预设的退场路径）。**注意**：`get_trace` 未实现，切换后「详情」仍按 ADR 第 2 条走上游既有 HTTP
> （`get_process`），不做改动。迁移清单与字段映射见 §8。

## 6. 只读取证复现步骤

以下命令是**需求提出时（交付前）**的只读取证步骤，保留原文；交付后同一命令应返回真实列表，
对照验证的完整清单见 §9.3。

```bash
# 1) 列表出口（交付前为桩，预期 {"spans":null} / {}；交付后应返回 spans 数组）
curl -s -X POST "$UPSTREAM/api/workflow_api/list_spans" \
  -H 'content-type: application/json' -b "$SESSION_COOKIE" \
  -d '{"workflow_id":"7694581096108785664","start_at":1791534000000,"end_at":1791535000000,"limit":20}'

# 2) 数据确实在库里（只读查询，示例）
mysql -e "SELECT id, workflow_id, version, mode, status, duration, created_at
          FROM opencoze.workflow_execution
          WHERE workflow_id = 7694581096108785664 ORDER BY id DESC LIMIT 10;"
```

## 7. 上游交付契约（已实现）

以下内容全部来自交付提交的代码/用例，可作为对接依据。

**7.1 端点与实现位置**

| 项 | 值 |
| --- | --- |
| 端点 | `POST /api/workflow_api/list_spans`（JSON body） |
| 路由注册 | `backend/api/router/coze/api.go:434` |
| handler | `backend/api/handler/coze/workflow_service.go:632` `ListRootSpans`（响应体在此拼装） |
| 应用层 | `backend/application/workflow/workflow.go:852` `ListRootSpans`（组装 `toRootSpan` `:999`、状态映射 `rootSpanStatuses` `:961`、模式映射 `executeModeOf` `:1044`） |
| 领域服务 | `backend/domain/workflow/service/history_query.go` `ListRootExecutions`（校验后透传） |
| 仓储 | `backend/domain/workflow/internal/repo/execute_history_store.go:570` `ListRootExecutions`（LIKE 转义 `:658`） |
| 鉴权 | 全局 session 中间件（`backend/main.go:100` 注册 `SessionAuthMW`）；缺 `session_key` cookie → `401` |
| 交付提交 | `3a028cf1`（实现：10 files，+998/−2）、`ea43584a`（分页/排序用例）、`cd796ef9`（钳制与默认窗口用例，新增 `backend/application/workflow/list_spans_test.go`） |

**7.2 请求字段（含默认值、钳制与报错）**

| 字段 | 类型 | 必填 | 语义 | 默认 / 钳制 | 非法时 |
| --- | --- | --- | --- | --- | --- |
| `workflow_id` | string（十进制） | 是 | 目标工作流；**一次请求只支持一个** | — | 解析失败或 ≤0 → `400` |
| `start_at` | i64 毫秒 | 否 | 窗口下界（**含端点**） | ≤0 / 未传 → `end_at − 7d` | `start_at > end_at` → `400` |
| `end_at` | i64 毫秒 | 否 | 窗口上界（**含端点**） | ≤0 / 未传 → 当前时间 | 同上 |
| `limit` | i16 | 否 | 条数上限 | ≤0 / 未传 → `20`；`>50` → 钳到 `50` | 不报错（静默钳制） |
| `offset` | i32 | 否 | 跳过条数 | `<0` → `0` | 不报错（静默兜底） |
| `desc_by_start_time` | bool | 否 | 排序方向 | 未传 → `true`（`created_at DESC, id DESC`）；`false` → `created_at ASC, id ASC` | — |
| `status` | SpanStatus(i32) | 否 | 执行状态过滤 | `0` / 未传 → 不过滤 | 越界 → `400` |
| `execute_mode` | i32 | 否 | 运行模式过滤 | `0` / 未传 → 不过滤 | 越界（非 0 且不在 1–3）→ `400` |
| `input` | string | 否 | 对 `workflow_execution.input` 做 **LIKE 子串**匹配（`%`/`_`/`\` 已转义） | 空串 → 不过滤 | — |

- **未采纳的建议字段**：`space_id`、`page_token`（见 §3 差异表）。
- 只返回**根执行**：`parent_node_id IS NULL OR parent_node_id = ''`。
- 排序始终带 `id` 兜底，同一毫秒内的顺序稳定；查询不 select `input`/`output`/`fail_reason`。
- `desc_by_start_time` 是 optional bool，语义是「字段是否传过」（`IsSetDescByStartTime()` = 字段非 nil，
  `backend/api/model/workflow/trace.go:1125`）：传 `false` 会真正切换为升序，漏传才是默认降序。

**请求示例**

```bash
curl -s -X POST "$UPSTREAM/api/workflow_api/list_spans" \
  -H 'content-type: application/json' -b "$SESSION_COOKIE" \
  -d '{
    "workflow_id": "7694581096108785664",
    "start_at": 1791534000000,
    "end_at":   1791535000000,
    "status": 0,
    "execute_mode": 0,
    "limit": 20,
    "offset": 0
  }'
```

**7.3 响应结构与字段**

成功为 HTTP `200` + **扁平结构**（不套 `data`）：`{"code":0,"msg":"","spans":[…]}`。0 条时 `spans` 是空数组
`[]`（不是 `null`）。顶层 `code` 必须为 `0`——上游前端拦截器把 `code !== 0` 当业务错误抛 `ApiError`
（`frontend/packages/arch/bot-http/src/axios.ts:90`），trace 选择器在顶层解构 `spans`
（`frontend/packages/workflow/test-run-next/trace/src/components/trace-select/use-options.ts:56`）。

| Span 字段 | 类型 | 取值 |
| --- | --- | --- |
| `trace_id` | string | = 兜底后的 `log_id` |
| `log_id` | string | DB `log_id`；**为空时回退为 `span_id`**（保证控制台可选中） |
| `span_id` | string | DB `id`（十进制字符串，即 execute id） |
| `type` | string | 恒为 `"Workflow"` |
| `name` | string | 工作流 meta 名称；名称为空时回退为 `workflow_id` |
| `parent_id` | string | 恒为 `"0"`（根执行） |
| `duration` | i64 毫秒 | DB `duration` |
| `start_time` | i64 毫秒 | DB `created_at`（执行**创建**时间） |
| `status_code` | i32 | DB `status == 2`(success) → `0`；**其余一律 `1`** |
| `tags` | list | 固定 11 项，见 §7.4 |
| `psm` / `dc` / `pod_name` | string | 恒为空串（本实现不填，可忽略） |

**示例响应**（字段与形态按 `toRootSpan` 输出；id/时间/名称为示意值）

```json
{
  "code": 0,
  "msg": "",
  "spans": [
    {
      "trace_id": "7694582493076258816",
      "log_id": "log-abc123",
      "psm": "",
      "dc": "",
      "pod_name": "",
      "span_id": "7694582493076258816",
      "type": "Workflow",
      "name": "my_workflow",
      "parent_id": "0",
      "duration": 1500,
      "start_time": 1791534594524,
      "status_code": 0,
      "tags": [
        { "key": "is_trigger", "tag_type": 0, "value": { "v_str": "true",               "v_double": null, "v_bool": null, "v_long": null,          "v_bytes": null } },
        { "key": "workflow_id", "tag_type": 0, "value": { "v_str": "7694581096108785664", "v_double": null, "v_bool": null, "v_long": null,          "v_bytes": null } },
        { "key": "execute_id",  "tag_type": 0, "value": { "v_str": "7694582493076258816", "v_double": null, "v_bool": null, "v_long": null,          "v_bytes": null } },
        { "key": "version",     "tag_type": 0, "value": { "v_str": "v0.0.2",             "v_double": null, "v_bool": null, "v_long": null,          "v_bytes": null } },
        { "key": "mode",        "tag_type": 3, "value": { "v_str": null, "v_double": null, "v_bool": null, "v_long": 2,             "v_bytes": null } },
        { "key": "status",      "tag_type": 3, "value": { "v_str": null, "v_double": null, "v_bool": null, "v_long": 2,             "v_bytes": null } },
        { "key": "node_count",  "tag_type": 3, "value": { "v_str": null, "v_double": null, "v_bool": null, "v_long": 4,             "v_bytes": null } },
        { "key": "error_code",  "tag_type": 0, "value": { "v_str": "", "v_double": null, "v_bool": null, "v_long": null,          "v_bytes": null } },
        { "key": "log_id",      "tag_type": 0, "value": { "v_str": "log-abc123",          "v_double": null, "v_bool": null, "v_long": null,          "v_bytes": null } },
        { "key": "duration",    "tag_type": 3, "value": { "v_str": null, "v_double": null, "v_bool": null, "v_long": 1500,          "v_bytes": null } },
        { "key": "created_at",  "tag_type": 3, "value": { "v_str": null, "v_double": null, "v_bool": null, "v_long": 1791534594524, "v_bytes": null } }
      ]
    }
  ]
}
```

> `tag_type`：`0` = STRING、`3` = LONG（`idl/workflow/trace.thrift:79`）。`value` 的 5 个键在每个 tag 上都会出现，
> 用不到的为 `null`（生成的 `Value` 结构体字段没有 `omitempty`）。上面的 JSON 形态是用仓库里的 sonic 序列化
> `Span` 实机核对过的，不是手写推测。

**7.4 DB 列 → Span 字段 / tag 对照表**

`tags` 固定 11 项且顺序固定：`is_trigger`、`workflow_id`、`execute_id`、`version`、`mode`、`status`、
`node_count`、`error_code`、`log_id`、`duration`、`created_at`。

| `workflow_execution` 列 | Span 顶层字段 | tag（key @ tag_type） | 说明 |
| --- | --- | --- | --- |
| `id` | `span_id` | `execute_id` @ STRING | 十进制字符串 |
| `log_id` | `log_id`、`trace_id` | `log_id` @ STRING | 顶层为空时回退 `span_id`；**tag 保留 DB 原值（可能是空串）** |
| `workflow_id` | — | `workflow_id` @ STRING | 顶层没有该字段，只能从 tag 取 |
| `version` | — | `version` @ STRING | 草稿运行为空串 |
| `mode` | — | `mode` @ LONG | 归一为 1/2/3（见 §7.5） |
| `status` | — | `status` @ LONG | DB 原值 1–5，**与 `status_code` 不是一回事** |
| `node_count` | — | `node_count` @ LONG | |
| `error_code` | — | `error_code` @ STRING | DB `NULL` → 空串 |
| `duration` | `duration` | `duration` @ LONG | 毫秒 |
| `created_at` | `start_time` | `created_at` @ LONG | 毫秒（执行创建时间） |
| （常量） | `type`=`"Workflow"`、`parent_id`=`"0"` | `is_trigger` @ STRING = `"true"` | 前端只用 `is_trigger` 判存在 |
| （工作流 meta） | `name` | — | meta 名称为空时回退 `workflow_id` |
| （派生） | `status_code` | — | DB `status=2` → `0`，其余 → `1` |

**7.5 状态与模式枚举**

| 请求 `status` | DB `status` | 语义 | 响应 `status_code` |
| --- | --- | --- | --- |
| `0` / 未传 | 不过滤 | — | — |
| `1` | `2` | success | `0` |
| `2` | `3` | fail | `1` |
| `3` | `1` | running | `1`（**上游控制台按红色失败图标渲染**） |
| `4` | `4` | cancel | `1` |
| `5` | `5` | interrupted | `1` |

- `status=5` 取自实体常量 `entity.WorkflowInterrupted = 5`
  （`backend/domain/workflow/entity/workflow_execution.go:63`）；DB 列注释只写到 4（`1=running 2=success 3=fail 4=interrupted`），
  实际是否产生 5 见 §9.2。
- **命名不一致（按数值对齐即可）**：DB 列注释把 `4` 写作 `interrupted`，而 IDL/实体常量把 `4` 命名为 `Cancel`
  （`idl/workflow/workflow.thrift:949`）、平台侧 DB 映射也把 `4` 叫 `interrupted`。对接按**数值**处理，不要按名称。
- `execute_mode` ↔ DB `mode` 一一对应且码值相同：`1`=debug、`2`=release、`3`=node debug；`0`/未传不过滤，越界 `400`。
- 渲染依据：上游控制台 `StatusIcon` 只在 `status_code === 0` 时显示绿色对勾，其余一律红色失败图标
  （`frontend/packages/workflow/test-run-next/trace/src/components/status-tag/index.tsx:33`）——**运行中的执行会显示为失败态**，
  这是既有前端行为，不是接口 bug。

**7.6 权限与错误码（务必按 `code` 判断，不要按 HTTP 状态码判断）**

| 情况 | HTTP | body |
| --- | --- | --- |
| 正常（含 0 条） | `200` | `{"code":0,"msg":"","spans":[…]}` |
| 跨 space / 无该工作流权限 | **`200`** | `{"code":777777775,"msg":"Workflow operation failure: user … does not have access to space …"}`（**没有 `spans` 字段**） |
| 未登录（无 `session_key` cookie） | `401` | `{"code":401,"msg":"missing session_key in cookie"}` |
| 参数非法（`workflow_id` / 时间窗 / `status` / `execute_mode`） | `400` | `{"code":400,"msg":"Invalid request parameters. Please check your input and ensure all required fields are correctly formatted and within allowed ranges."}`——**msg 不区分是哪个参数**，具体原因只在服务端日志 |
| 其它非业务错误 | `500` | `{"code":500,"msg":"internal server error"}` |

权限链路：`workflow_id` → 反查工作流 meta 取 `space_id`（`MetaOnly`）→ `checkUserSpace`（比对当前登录用户的
space 成员列表）。跨 space 沿用了既有接口口径：`checkUserSpace` 返回普通 error → 应用层
`WrapIfNeeded(errno.ErrWorkflowOperationFail)`（`777777775`，`backend/types/errno/workflow.go:56`）→ handler 走
`internalServerErrorResponse` → `httputil.InternalError` 对「带非 0 业务码的 StatusError」返回 **HTTP 200 + code**
（`backend/api/internal/httputil/error_resp.go:43`），与 `get_process`（`GetWorkFlowProcess` 同文件 `:447`）等既有接口一致。

## 8. fenix 侧对接指引（从直连库切回 HTTP）

> **状态注（2026-10-09 切换后补记；原文保留、不作改写）**：本节写于切换**之前**，是「从直连库切回 HTTP」的预设
> 指引，实际落地与它有四处差异——① 文中指向的
> `packages/resources/workflow-v2/src/server/adapters/upstream-execution-db.ts` **从未启用**（只读直连方案在切换前
> 未上过线），已随本次切换连同 `WORKFLOW_V2_UPSTREAM_DB_*` 一并删除，§8.1 第 1、4 条因此没有对应动作；② §8.1
> 第 1 条要求「`items`/`itemsState` 对外契约不变、把三态收敛为 `ok | failed`」**未按原样实现**：最终响应是
> `items` / `platformRuns` / `truncated` / `hasMoreUpstream`，**没有 `itemsState`**（HTTP 语义下失败即失败），见
> `packages/resources/workflow-v2/src/server/services/workflow-run-records.ts`；其中 `hasMoreUpstream` 是「上游可能还有
> 更早的运行」的**页满推断**（扇出后**任一**目标本次 `spans.length` 等于请求页大小 20 即置真；上游没有
> `has_more`/游标，某工作流在窗口内恰好一页时是假阳性，故文案只说「可能」；与平台侧上屏裁剪 `truncated`
> 相互独立、可同时为真），最终口径见 `docs/arch/25-workflow-v2.md` §8；③ §8.3 的建议错误映射与最终实现
> 不一致，见该小节末条补记；④ §8.1 第 5 条只落实了一行——契约快照第 29 行（`list_spans`）已改为「已实现」，
> 29b（应用级发布记录，本就不是桩）/ 29c（工作流级发布记录，仍为桩）与本次交付无关，未按该条一并改动。
> 切换后的正式口径以 `docs/arch/25-workflow-v2.md` §8 为准。

**8.1 迁移要点**

1. **读路径**：`packages/resources/workflow-v2/src/server/adapters/upstream-execution-db.ts` 的
   `readUpstreamExecutions` 换成调用本接口；`packages/resources/workflow-v2/src/server/services/workflow-run-records.ts`
   的 `items` / `itemsState` 对外契约不变，把三态 `ok | not_configured | failed` 收敛为 `ok | failed`
   （HTTP 版没有「未接入」这一态）。
2. **一次请求一个 `workflow_id`**：DB 版是 `workflow_id IN (…)`（多目标一次取回），HTTP 版只接受单个 id ⇒
   对多目标逐个请求后在平台侧归并（按 `start_time` 降序、同刻用 `span_id`/execute id 兜底），或先确认目标集是否真会 >1。
3. **`space_id` 不再由平台传**：DB 版的 `space_id` 谓词是纵深防御；HTTP 版服务端按工作流反查 space 并做成员校验。
4. **移除只读账号**：切换后按 ADR「移除条件」删掉直连适配器与
   `WORKFLOW_V2_UPSTREAM_DB_{HOST,PORT,USER,PASSWORD,NAME}`，运维文档同步删除只读账号。
5. **契约快照更新**：`docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md` 中 list_spans 相关行
   （29/29b/29c）应从「桩」改为「已实现」，并登记 §7 契约。

**8.2 字段映射（`UpstreamExecutionRecord` ← Span / tags）**

| 平台字段（现取自 DB 列） | HTTP 来源 | 备注 |
| --- | --- | --- |
| `executeId`（`id`） | `span_id`（= `tags.execute_id`） | 十进制字符串，BIGINT 精度口径不变 |
| `workflowId`（`workflow_id`） | **`tags.workflow_id`** | Span 顶层没有该字段，**只能从 tags 取** |
| `version`（`version`） | **`tags.version`** | 空串仍归一为 `null` |
| `mode`（`mode`） | **`tags.mode`** | `1/2/3` 与现有 `toMode` 完全一致 |
| `status`（`status`） | **`tags.status`** | DB 原值 `1–5`；现有 `toStatus` 只认 `1–4`，见下方差异 |
| `durationMs`（`duration`） | `span.duration`（= `tags.duration`） | 毫秒整数，语义不变 |
| `createdAt`（`created_at`） | `span.start_time`（= `tags.created_at`） | 毫秒时间戳；平台侧 `toIsoString` 可原样复用 |
| `errorCode`（`error_code`） | **`tags.error_code`** | DB `NULL` → 空串，仍归一 `null` |
| `nodeCount`（`node_count`） | **`tags.node_count`** | |
| `logId`（`log_id`） | `span.log_id`（唯一键/回查）或 **`tags.log_id`**（DB 原值） | 两者不同：顶层保证非空（空则回退 `span_id`），tag 保留「有没有真实 log id」 |
| `commitId`（`commit_id`） | **无** | 本接口既不在 Span 顶层也不在 tags 返回 `commit_id`（仓储查询也不 select 该列）；平台若仍需该字段，必须另找来源或先置 `null` |
| `spaceId`（查询参数） | 不需要 | 服务端反查 + 成员校验 |

**两处口径差异（不要照抄现有 DB 映射的行为）**

- `mode`：DB 版对认不出的码返回 `null`；HTTP 版**在服务端先归一**——DB `mode` 不是 1/2 的一律落到「节点调试」
  （`listItemToEntity` 的 `else` 分支，`execute_history_store.go:627`），因此 tag `mode` 只会是 `1/2/3`。
- `status`：HTTP 版透传 DB 原值，`5` 也会出现；平台现有 `toStatus` 对 `5` 返回 `null`，切换后要么补上 5 的映射，
  要么先确认 5 是否真会出现（§9.2）。

**8.3 错误与权限处理**

- **先看 `body.code`，再看 HTTP 状态码**：跨 space 是 `200 + code=777777775`，只按 `4xx` 判断会把「无权限」当成功。
- 建议映射：`code===0` → `ok`（`spans` 为空数组即「确实没有记录」）；`401` → 未登录/会话失效（提示重新登录，
  与现有平台会话失效口径一致）；`400` → 平台侧参数 bug（不重试）；`code===777777775` → 目标工作流不属于本空间
  （按「无权限/目标不可用」处理，**不要渲染成空列表**）；其余 → `failed`（沿用现有「读取失败」文案）。
- **错误响应没有 `spans` 字段**：解析时用 `Array.isArray(body?.spans) ? body.spans : []`，同时保留 `code` 判定，
  避免把错误当空列表吞掉（这正是现有 `itemsState` 三态想表达的区别）。
- **与最终实现的差异（2026-10-09 补记）**：上面那条建议映射与落地实现**不一致**——实现里没有「按 `777777775`
  判无权限、按 `401` 判会话失效」这两个分支：上游返回带业务码的响应（含 `code=777777775`）统一映射为 502
  `UPSTREAM_REJECTED`；上游 `401`/`700012006` 走「换会话 + 重放一次」，重放仍失效才是 503
  `PLATFORM_SESSION_UNAVAILABLE`；超时 504、网络 502。**以实现为准**（统一映射见
  `packages/resources/workflow-v2/src/server/routes/web/workflow-http.ts`，口径记录见
  `docs/arch/25-workflow-v2.md` §8），本差异是已知项；原文保留，只作当时的判断记录。
- 超时/重试沿用现有「短预算、不重试」策略即可（HTTP 版比直连库多一层上游进程，建议仍用 3s 量级预算）。

**8.4 分页与时间窗**

- 只有 `limit`（≤50，超出被静默钳到 50）与 `offset`；**没有 `has_more` / 游标** ⇒ 用「本页条数 < `limit`」判断到底。
- 顺序保证只有 `created_at DESC, id DESC`；翻页期间若有新执行写入，`offset` 页会整体后移（无游标可锚定）。
- **显式传 `start_at`/`end_at` 并在一次翻页过程中保持不变**：不传时窗口默认是 `end_at − 7d`（`end_at` 缺省为「现在」），
  窗口会随请求时间漂移。
- 现有界面口径（最近 7 天 / 最多 50 条）与上游一致：上游前端选择器用的就是 `limit=50`、7 天窗
  （`frontend/packages/workflow/test-run-next/trace/src/constants.ts:22`）。

## 9. 验收对照与证据

**9.1 §4 四条逐条对照**

| # | 原验收条款（原文保留） | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 对同一 workflow 的 3 条历史执行能一次列出，字段值与 `workflow_execution` 一致 | ✅ **已覆盖** | `backend/api/handler/coze/workflow_service_test.go` → `TestListRootSpans` / `"list executions"`：造 3 行（2 根执行 + 1 子流程执行），断言只回 2 条为根执行，并逐项校验 `span_id`/`log_id`/`trace_id`/`parent_id`/`type`/`name`/`status_code` 与 11 个 tag 的值；DB 行 → 实体的映射另有 `execute_history_store_list_test.go` 对 `listItemToEntity` 输出字段的断言 |
| 2 | 时间窗、状态、模式过滤生效；分页稳定（分页期间新增执行不改变既有页结果） | ⚠️ **过滤与排序已覆盖；「分页期间新增」不成立** | **过滤/排序**：仓储 `TestListRootExecutions_AllFilters`（sqlmock 直接断言 SQL：`workflow_id` + `created_at` 区间 + `status IN (…)` + `mode` + `input LIKE`（转义 `%`、`_`、`\`），`ORDER BY created_at DESC, id DESC` + `LIMIT/OFFSET`）；handler `"filter by status and input"`、`"limit and ascending order"`（`limit=1` 取最新、`desc_by_start_time=false` 取最早）。**钳制与默认窗**：`backend/application/workflow/list_spans_test.go` → `TestListRootSpansFilterDefaults`（mock 域服务捕获下推的 `ListExecutionFilter`）：`limit` 未传/`0` → `20`、`51` → `50`、`50` 与 `7` 原样；未传 `start_at` → 精确等于固定 `end_at − 7d`（`1700000000000` → `1699395200000`，用固定 `end_at` 断言，无 flaky）；`offset<0` → `0`；`desc_by_start_time` 未传 → `true`，显式 `false` → 透传。**分页稳定性**：实现只有 `limit`/`offset`，没有游标 ⇒ 窗口内新增执行会让后续页整体位移（§9.2） |
| 3 | 跨 space 请求被拒绝 | ✅ **已覆盖（返回形态不是 4xx）** | handler `"no access to the workflow space"`：断言 HTTP `200`、`code != 0`、`spans` 为空；错误码取值（`777777775`）由 `ErrWorkflowOperationFail` + `httputil.InternalError` 口径决定，见 §7.6 |
| 4 | 上游自身 trace 选择器恢复可用（同一根因的回归验证） | ⏳ **待人工回归** | 上游前端**零改动**即可：选择器调的就是本接口（顶层解构 `spans`，`frontend/packages/workflow/test-run-next/trace/src/components/trace-select/use-options.ts:56`），并依赖 `log_id` 非空唯一（用作缓存键，同文件 `:89`）、`start_time`（毫秒，`getTimeFromSpan`）、`status_code`、tags `is_trigger`（仅判存在，`frontend/packages/workflow/test-run-next/trace/src/utils.ts:37`）、`tags.execute_id`/`tags.workflow_id`（跳转调试，同文件 `:81`）——这些字段 §7.3 全部提供。验证入口见 §9.3；`get_trace` 未实现，选中后 trace 树/详情仍为空 |

**9.2 未实现 / 已知边界（对接方不要误判）**

- **`get_trace`（`GetTraceSDK`）仍是空壳**：`backend/api/handler/coze/workflow_service.go:663` 仍是 bind 后
  `c.JSON(200, 空结构体)` ⇒ 列表有了，但「选中某次执行后的 trace 树/详情」仍为空，属另一个需求。
- **无游标分页**：没有 `has_more` / `next_page_token`，稳定性只靠 `created_at DESC, id DESC` 与 offset 语义；
  高频写入或深度翻页需平台侧自行处理位移（§8.4）。
- **未加 DB 索引迁移**：默认查询是 `workflow_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC, id DESC`，
  现有索引 `idx_workflow_id_version_mode_created_at (workflow_id, version, mode, created_at)`
  （`docker/atlas/opencoze_latest_schema.hcl:4422`）中间夹了 `version`/`mode`，无法服务 `ORDER BY created_at`。
  建议后续补 `(workflow_id, created_at, id)` 索引（本次交付未包含迁移）。
- **状态 5（interrupted）**：实体常量有 `WorkflowInterrupted = 5`，但本次核对未在实现里找到写入点、
  DB 列注释也只到 4；接口已按代码支持 `status=5` 过滤与 `tags.status=5`，**是否真会出现待运行数据确认**。
- **两侧「根执行」判定列不同**：接口用 `parent_node_id`，平台 DB 版用 `root_execution_id`（自引用/NULL/0）——
  切换后以接口口径为准。
- **`commit_id` 不返回**（§8.2），平台需要该字段就得另找来源。

**9.3 验证方式（人工回归清单）**

```bash
# ① 接口直连 + 与库里对照
curl -s -X POST "$UPSTREAM/api/workflow_api/list_spans" \
  -H 'content-type: application/json' -b "$SESSION_COOKIE" \
  -d '{"workflow_id":"7694581096108785664","limit":20}'
# 期望：code=0；spans 里每条的 span_id/version/mode/status/duration/created_at 与下面 SQL 对应行一致
mysql -e "SELECT id, workflow_id, version, mode, status, duration, created_at, error_code, node_count, log_id
          FROM opencoze.workflow_execution
          WHERE workflow_id = 7694581096108785664 AND (parent_node_id IS NULL OR parent_node_id = '')
          ORDER BY created_at DESC, id DESC LIMIT 20;"

# ② 权限：换一个不属于当前登录用户 space 的 workflow_id
#    期望：HTTP 200 + body code=777777775（不是 403/404）

# ③ 边界：status=9 或 start_at > end_at
#    期望：HTTP 400 + body code=400

# ④ 上游 trace 选择器（人工）
cd frontend/apps/coze-studio && npx rsbuild dev   # 注意：不要带 IS_OPEN_SOURCE=true
# 打开工作流画布 → 工具栏 trace 按钮 → 时间窗内应列出执行记录，点击可按 log_id 选中
```

> **启动方式很关键**：`npm run dev` / `npm run build` 会设 `IS_OPEN_SOURCE=true`
> （`frontend/apps/coze-studio/package.json:13`），而 trace 按钮在该构建下被编译掉
> （`frontend/packages/workflow/playground/src/components/toolbar/components/tools.tsx:82`）；
> 直接 `npx rsbuild dev` 时 `IS_OPEN_SOURCE` 缺省为 `false`
> （`frontend/packages/arch/bot-env-adapter/src/base.ts:47`），按钮才会渲染。
