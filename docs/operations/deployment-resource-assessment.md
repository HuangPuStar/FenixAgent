# 部署资源评估

## 1. 配套服务

| 服务 | 用途 | 资源占用因素 |
| --- | --- | --- |
| 主服务 | Agent 资源管理、Agent 编排、Agent 实例管理、访问入口和业务数据存储 | 在线连接、活跃 Agent |
| LiteLLM | 模型请求代理、鉴权、限额与用量记录 | 请求并发、流式连接 |
| Agent 运行时 | 执行 Agent 的代码、工具和任务 | 任务等级、并发数 |
| Agent Sites | 发布和运行 Agent 生成的站点 | 活跃站点数 |
| Hindsight | Agent 长期记忆的存储与召回 | 记忆量、调用并发 |
| RAGFlow | 文档解析、切分、Embedding、检索与知识库管理 | 分片数、索引并发 |
| Langfuse | Agent 和模型调用的 Trace、观测与分析 | 事件量、保留期 |

除明确说明外，以下磁盘公式只计算**在线主副本**；备份、异地副本、快照和滚动升级余量必须另行预留。生产节点不建议长期以超过 70% 的 CPU、内存或磁盘使用率运行。

## 2. 评估指标

| 符号 | 含义 | 建议初始取值 / 获取方式 |
| --- | --- | --- |
| `U` | 注册用户数 | 50、100、250、500、1,000 |
| `p` | 高峰时正在执行 Agent 任务的用户占比 | 常规企业办公场景先按 5%；高使用率或集中培训按 8%～15% |
| `nL` | 轻任务比例 | 日常问答、文档处理等单次 10 分钟内完成的任务 |
| `nM` | 中任务比例 | 数据分析、长任务处理等单次 30 分钟内完成的任务 |
| `nH` | 重任务比例 | 科研、探索类任务，单次 30 分钟以上 |
| `nX` | 超重任务比例 | 深度分析、探索和多并发任务，单次通常 1 小时以上 |
| `As` | Agent Sites 活跃应用数 | 按需 |
| `Hw` | Hindsight API 等效进程数 | `ceil(N / 12)`；当前单 API 为 1 |
| `K` | RAGFlow 已入库分片数 | RAGFlow / Infinity 统计值 |
| `Q` | RAGFlow 峰值并发 | 索引和检索任务的同时执行数 |
| `W` | 单用户工作区配额 | 5～10 GiB |
| `s` | 用户工作区超卖系数 | 不超卖取 `1`；适度超卖可取小于 `1` 的值，如 `0.8` |

先计算：

```text
B  = ceil(U / 50)            # 50 用户基础套餐份数
N  = ceil(U × p)             # 峰值活跃 Agent 数
nL + nM + nH + nX = 1        # 四类任务比例之和必须为 1
Hw = ceil(N / 12)            # 每 12 个峰值活跃 Agent 对应一个 Hindsight API / Worker
```

## 3. 通用预留规则

下列公式是单机混部时的常驻资源估算，不在每个服务上重复叠加余量。汇总后，CPU、内存和磁盘各保留 20%～30% 空间即可。备份不计入在线磁盘，至少另配 `1 ×` 全量备份空间。

## 4. 资源估算

### 4.1 平台基础套装

主服务（含 PostgreSQL）、LiteLLM、Agent 运行时、Hindsight 和 Agent Sites 合并为一个基础套装，不再分别估算。

基础套装适用于：`50` 用户、`p = 15%`（即 `N = 8`）、全部为轻任务、`As = 5` 个活跃应用、`Hw = 1`。建议先配置：

```text
8 C / 16 GiB
```

先按每 `50` 个用户配置一份基础套装：`B = ceil(U / 50)`。例如 `100` 用户先配置 `2 × (8 C / 16 GiB)`，再计算两份套餐之外的增量。CPU 单位为 C，内存单位为 GiB，结果向上取整：

```text
CPU = 8 × B
    + 0.5 × max(0, N - 8 × B)
    + 1.5 × N × nM
    + 3.5 × N × nH
    + 7.5 × N × nX
    + 2 × max(0, Hw - B)

内存 = 16 × B
      + 0.3 × max(0, N - 8 × B)
      + 3.7 × N × nM
      + 7.7 × N × nH
      + 15.7 × N × nX
      + 0.1 × max(0, As - 5 × B)
      + 2 × max(0, Hw - B)
```

- 每份套餐已覆盖 `8` 个轻任务并发、`5` 个活跃 Agent Sites 应用和 `1` 个 Hindsight API / pg0。超过套餐总覆盖量的轻任务并发，按每个 `0.5 C / 0.3 GiB` 增加。
- 中、重、超重任务分别按相对轻任务的增量增加 `1.5 C / 3.7 GiB`、`3.5 C / 7.7 GiB`、`7.5 C / 15.7 GiB`。
- 活跃应用超过 `5 × B` 时，每个应用增加 `100 MiB` 内存。
- `Hw = ceil(N / 12)`；如高并发使其超过套餐已含的 API 数量，每多一个 API / Worker 增加 `2 C / 2 GiB`。单 API 的完整镜像建议 `2 GiB`，pg0 建议至少 `1 GiB`。参考 [Hindsight 官方部署内存指南](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/guides/2026-04-28-guide-size-hindsight-memory-footprint-for-deployments.md)。

基础套装磁盘按服务数据和用户数据估算：

```text
用户数据 = U × W × s
服务数据 = 1 TiB 起步，后续按实际增长扩展
在线磁盘 = 服务数据 + 用户数据
```

其中，`W` 为每用户 `5～10 GiB` 工作区配额；`s` 为超卖系数，不超卖取 `1`，例如取 `0.8` 表示按用户配额总量的 80% 配置物理磁盘。服务数据包含数据库、容器镜像、日志和 Hindsight 数据，难以在部署前精确估算，建议独立从 `1 TiB` 起步。备份空间不计入在线磁盘。

### 4.2 RAGFlow

RAGFlow 不纳入统一公式。官方未发布按分片数 `K`、峰值并发 `Q` 换算 CPU、内存和磁盘的公式；官方给出的生产起步规格为：

```text
4 C / 16 GiB / 50 GiB
```

实际需求取决于文档引擎、数据量、解析任务、并发和是否运行本地模型。`K/Q` 应作为扩容压测和线上监控指标，不应伪造成固定换算系数。参考 [RAGFlow 官方 Quickstart](https://ragflow.io/docs/)。

### 4.3 Langfuse

Langfuse 不纳入统一公式。官方 Helm Chart 的生产 sizing 建议按组件分别配置：

| 组件 | CPU limit | 内存 limit | 已声明磁盘 |
| --- | ---: | ---: | ---: |
| Langfuse Web（1 副本） | 2 C | 4 GiB | — |
| Langfuse Worker（1 副本） | 2 C | 4 GiB | — |
| PostgreSQL | 2 C | 2 GiB | — |
| ClickHouse | 2 C | 8 GiB | 100 GiB |
| ClickHouse Keeper（每副本） | 1 C | 1 GiB | 20 GiB |
| Redis | 1 C | 1.5 GiB | — |
| 内置对象存储（SeaweedFS） | 2 C | 4 GiB | — |

官方 Chart 默认配置 1 个 Web、1 个 Worker、1 个 ClickHouse 和 3 个 Keeper；按上表 limit 合计为 `14 C / 26.5 GiB`，已声明磁盘为 `210 GiB`（ClickHouse 100 GiB、3 个 Keeper 各 20 GiB、SeaweedFS 50 GiB）。对象存储容量仍须按 Trace 附件、导出和事件归档另行增加。生产可使用外置 PostgreSQL、ClickHouse、Redis 和对象存储，但必须在对应托管服务上保留等价资源。官方没有按事件量或保留期给出统一换算公式，事件量应通过 ClickHouse 和对象存储的实际增长率压测确定。参考 [Langfuse 官方 Helm Chart sizing](https://github.com/langfuse/langfuse-k8s#sizing)。

## 5. 使用方式

先计算套餐份数 `B = ceil(U / 50)`、`N = ceil(U × p)` 和 `Hw = ceil(N / 12)`，再代入基础套装公式。每一份套餐之外的轻任务并发、中 / 重 / 超重任务和活跃应用数，均只计算增量。

RAGFlow 与 Langfuse 独立申请资源：前者按数据量、解析和检索压测扩容；后者按官方组件规格部署，并以 Trace 增长率和保留期校正磁盘。
