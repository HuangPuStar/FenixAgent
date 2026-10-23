# 看板、告警与指标映射

1. 四份 `*.dashboard.json` 采用官方社区看板的 version 2 可导入形状，平台/主机容器/同步恢复/采集链路分别管理；生成入口 `bun run scripts/generate-observability-assets.ts`。
2. `alerts.json` 是**未启用的候选模板**：当前 9 条规则全部 `enabled=false`，`destinations` 全部为空。导入后必须选择实际 stream、环境、目的地、时区并校准条件，逐条启用并完成 G06 的触发/恢复验证；仓库状态不代表任何告警已上线。
3. environment/service/time 是基本筛选；应用默认 fenix-server，基础设施与 Collector 使用自身身份。缺数据不补0。
4. 服务不可达、OO/Collector 入口不可达由独立探测每30秒执行，连续2分钟失败通知；OO 宕机时不能依赖自身通知。

## 启用前自检（模板状态）

```bash
jq 'length' docker/openobserve/assets/alerts.json                                    # 当前 9
jq -e 'all(.[]; (.destinations | length) > 0)' docker/openobserve/assets/alerts.json  # 模板阶段预期退出码 1
jq -e 'all(.[]; .enabled == true)' docker/openobserve/assets/alerts.json              # 模板阶段预期退出码 1
```

两条 `jq -e` 是上线闸门而不是运行验证：通过后仍需注入故障确认触发与恢复，并验证 OO 不可用时由独立探测通道通知（G06）。

## 候选映射（需 A24 实测确认）

| OTel 原名 | 候选 OO 名称 | 语义 |
| --- | --- | --- |
| `http.server.request.duration` | `http_server_request_duration_{count,sum,bucket}` | 秒；显式累计桶，P95 用 rate(bucket) |
| `db.client.operation.duration` | `db_client_operation_duration_{count,sum,bucket}` | 客户端操作秒 |
| `db.client.connection.count/max/pending_requests` | 点号转下划线 | 当前池状态；max 仅宿主补缺 |
| `fenix.agent.active` | `fenix_agent_active` | 当前活跃实例 |
| `fenix.agent.runs` | `fenix_agent_runs_total` | 运行结果累计，需处理重启 |
| `fenix.sync.connections/queue.tasks/outstanding.bytes/unacked.deliveries` | 点号转下划线 | 当前状态，不是累计 |
| `fenix.sync.ack.duration` | `fenix_sync_ack_duration_{count,sum,bucket}` | 秒 |
| `fenix.sync.disconnects/failures` | 点号转下划线 + `_total` | 事件累计 |
| `fenix.history.restore.duration` | `fenix_history_restore_duration_{count,sum,bucket}` | 提交且可读代次完成 |
| `fenix.snapshot.persist.duration/size` | 点号转下划线 + histogram 后缀 | CAS 秒/编码字节 |
| Resource `service.name` / `deployment.environment.name` | `service_name` / `deployment_environment_name` | 实际展开以目标 OO 为准 |

单位后缀、Counter `_total`、Resource 前缀与 `_bucket` 形式不保证与候选一致。必须先发送已知输入，在 OO 检查实际 stream/labels，再统一修正生成器和告警模板，不改业务埋点名称。样本查询不得用完整 URL/会话 ID 充当指标维度。

显式桶与单位：`fenix.sync.ack.duration`、`fenix.history.restore.duration`、`fenix.snapshot.persist.duration`、`fenix.agent.run.duration`、`fenix.agent.start.duration` 使用秒桶 `[0.005,0.01,0.025,0.05,0.1,0.2,0.5,0.9,2.5,5,10,30,60,300,600,1800,3600]`；`fenix.snapshot.size` 使用字节桶 `[1024,4096,16384,65536,262144,1048576,4194304,16777216,67108864,268435456]`。小时级边界避免长 Agent 运行/大历史恢复落入 `+Inf`；看板中的 `histogram_quantile(..., rate(..._bucket[...]))` 必须保持原单位。候选映射未在 OO v1.1.2 实测前不得作为生产断言。

日志在 `fenix_logs`，通过 trace ID 查 Trace；原始 OTel trace ID 是否映射为 `trace_id` 需在目标 OO 核实。运维初版只对平台运维开放，不提供租户自助权限。
