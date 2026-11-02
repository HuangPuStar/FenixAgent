# 标准观测运维手册

## 1. 发布前检查

1. 应用基线与冻结版本见 `docs/design/observability-implementation.md`；镜像 tag 是候选运行组合，不代表已通过真实数据验收。上线记录应用 SHA、Bun 版本（当前冻结 1.4.3，CI 与生产镜像一致）、三类镜像 digest、配置版本和目标 CPU 架构。
2. 数据目录都在各自编排的 `./data`；Collector 为 UID/GID 10001 创建 `data/storage`，至少预留 5GiB。OO 需核实镜像运行用户与数据权限。
3. 凭据由秘密管理器或不入库 `.env` 注入。OO root 初始化与 Collector 采集凭据分开，应用不接收 OO 凭据。
4. feature 只控制本目录：`FENIX_FEATURE_OTEL_COLLECTOR`、`FENIX_FEATURE_OPENOBSERVE` 默认关闭，由目录发现/环境生成器登记，不会互相启用。
5. 前端观测不在本次范围：仓库不包含浏览器 SDK、同源 OTLP 上报入口或 Collector browser pipeline；A17/A18 与 G05 均按“不适用”记录，不要为浏览器链路准备验收环境。

## 2. 首次部署

1. 主服务先创建 `fenix-server`。分别准备 `docker/openobserve/.env`、`docker/otel-collector/.env` 和数据权限；两套 Compose 都要求同目录 `.env`（Collector 经服务 `env_file`，OO 经 Compose 变量插值），必须在执行 `docker compose config` 前从 `.env.example` 复制并填写，否则静态校验会报 `.env not found` 或缺少必填变量。
2. 各目录执行 `docker compose config --quiet`。拉取 OO 固定镜像后初始化管理员、组织与独立采集凭据。
3. Collector 的 `OO_OTLP_ENDPOINT` 为必填且模板默认留空：同机且两栈都接入 `fenix-server` 时可填 `http://openobserve:5080/api/default`，跨机必须使用受控 HTTPS 地址，不带尾斜线；空值会以 `set OO_OTLP_ENDPOINT` 让 `docker compose config` 失败，这是有意的前置检查。`OO_AUTH_HEADER` 由 OO 接入页取得，不在终端/报告中打印。
4. `docker compose run --rm otel-collector validate` 必须传与运行相同的所有 `--config`。基础只含 `collector.yaml`；按需要加 host/PG/Redis/Docker/filelog。
5. 启动 Collector 后独立探测 13133；核对 8888 指标的拒绝、发送失败、队列占用。不要以容器 running/HTTP 200 代替数据健康。
6. 应用设置 `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`（要求应用与 Collector 同机接入 `fenix-server`；跨机时改为受控 HTTPS 入口，Docker 服务名不能跨主机解析），联调采样率 1；生产初始 0.1，指标不随采样下降。首次部署在 `docker/main/.env` 显式写出 `OTEL_RESOURCE_ATTRIBUTES=service.namespace=fenix,deployment.environment.name=production` 并核对生效值（生产编排的缺省注入也是 production）；staging 等环境改成 `deployment.environment.name=staging`，不能沿用 development。应用、Collector 的 `DEPLOYMENT_ENVIRONMENT` 与看板筛选必须使用同一个环境名。
7. 部署资产统一位于 `docker/openobserve/`、`docker/otel-collector/`，各自自包含编排与配置；只有 `docker/openobserve/assets/` 存放看板、告警与指标映射，`docker/otel-collector/` 是按需采集配置（`collector.*.yaml`），不含 `assets/`。跨机部署时整目录拷贝，目标机先创建同名外部网络 `docker network create fenix-server`；跨机使用受控 HTTPS，Docker 服务名不能跨主机。

## 3. 数据语义验收

A01–A26 的逐项场景、证据要求与当前状态见 §8，运行门禁 G01–G07 见 §9。每次记录输入、时间、配置与版本、Collector 状态和 OO 查询结果。

1. 普通请求、400/404/500、异常、SSE 完成/取消：日志与 Trace ID 一致，直方图计数/状态/路由正确，Span 不残留。
2. 用已知请求数比较采样 1/0.1：Trace 数变化，指标 count 不变；注入已知耗时样本检查 count/sum/累计桶/P95。
3. PG 查询/等待/错误与 ioredis 前后台任务：自动插件生效，池状态与驱动真实状态一致；无 SQL、参数、连接串、Cookie、正文泄漏。
4. 无故障时 N 条唯一日志得到 N 条；stdout、本地与 OO 都检查禁止字段；Observer 原日志页面仍可读。
5. 主机/容器数据与宿主工具比对。Mac Docker Desktop 只代表 VM/容器；未部署 Redis 就不加载 Redis receiver。
6. 同步积压/ACK 后回落、断连释放、恢复完成/失败、快照耗时大小与既有信号一致；不扫描历史，不保留销毁 scope。
7. Agent 启动/退出/失败/取消结果每代次只记一次；多实例与重启身份正确。
8. OO 停止 10 分钟、Collector 带队列重启、队列满/磁盘不足/401：业务继续服务，已持久数据按预算恢复，丢失窗口明确。
9. SIGTERM 有界刷新；强杀允许丢 SDK 内存。禁用 SDK 时业务照常；同机同负载对比吞吐/P95/CPU/RSS/事件循环，初始 P95 成本预算 5%。

## 4. 看板与告警

1. `docker/openobserve/assets/` 保存四类候选看板、规则和映射；先校准 OO 实际指标名/属性/单位再导入。命名转换只改部署资产，不改业务 OTel 名称。
2. 所有看板筛环境/服务/时间；缺数据单独显示，不能当成零错误。累计 Counter 用 rate/increase 处理重启。
3. 5xx 5分钟 >5% 且至少100请求、P95 >2秒、池等待、同步积压、恢复失败、队列 >80% 持续5分钟、拒绝数据与磁盘 <15% 为起点。
4. 服务不可达2分钟和 OO/Collector 入口不可达由独立探测通道通知；OO 自身宕机不能依靠 OO 发告警。
5. `alerts.json` 当前 9 条规则全部禁用且 `destinations` 为空，只是模板；上线前按 §10 配置通知目标、启用并做触发/恢复验证，不得把模板状态描述为已启用。

## 5. 升级与备份

1. 三个组件独立升级，每次保存版本与回退点，目标版本先 `validate`、三信号/直方图/持久队列恢复测试。
2. 不改 exporter/receiver ID、队列目录与文件 offset 路径；修改前评估重放和遗漏。
3. Collector 配置入 Git，凭据独立备份。队列是短期缓冲，不是长期备份；容量按峰值序列化字节/秒 × 故障窗口 × 安全系数计算。
4. OO 停写后一致性备份 `./data`，同时保存看板/告警；实际做恢复演练。存储不可逆迁移不能只换旧镜像。
5. 维护前估算队列和重试窗口。三出口各256MiB不等于总磁盘只需768MiB，还需状态/碎片余量；重试上限30分钟不是保证能扛30分钟故障。

## 6. 排障与回滚

| 信号 | 检查与动作 |
| --- | --- |
| 应用正常但无数据 | 是否显式 endpoint、采样、exporter none；Pino/PG/ioredis 是否在入口后首次加载；检查限频 stderr |
| Collector 拒绝/内存限制 | 查批大小、receiver 错误；不要无界放宽 |
| 出口401 | 校验组织/独立采集凭据，轮换秘密，不打印 Header |
| 队列持续增长 | OO 可达性/写入、磁盘权限与空间；修复后确认排空，警惕故障重放重复 |
| PG/Redis 来源重复 | 每目标保留一个 receiver 采集者；客户端埋点不等于服务端统计 |
| 回滚应用 | 先 `OTEL_SDK_DISABLED=true`，或回退应用镜像；业务协议与数据库无变化 |
| 回滚 Collector/OO | 恢复匹配配置/镜像并确认状态兼容；OO 必要时恢复一致性备份，绝不删除 data |

## 7. 停止与升级顺序

启动顺序与停止相反：先起主项目 `postgres` 创建 `fenix-server`，再起 `openobserve`、`otel-collector`，最后起 `rcs` 与普通依赖；应用首批遥测因此有接收端，且不需要跨项目 `depends_on`。

1. `./deploy.sh down` 的顺序固定：`docker compose ... stop rcs`（应用收到 SIGTERM 并完成有界关闭）→ 停普通依赖 → 等 5s 让 Collector 批量导出（未启用 Collector 时跳过）→ 停 `otel-collector`（其 30s 宽限期冲刷出口队列）→ 停 `openobserve` → `docker compose down` 清理 `fenix-server`。应用退出期间 Collector/OO 必须保持可用；两套 Compose 保持独立，不引入跨项目 `depends_on`。
2. 应用关闭预算为 5s 请求排空 + 10s 宿主清理 + 5s SDK flush（约 20s）；根 `docker-compose.yml` 与 `docker/main/docker-compose.yml` 的 `rcs` 都设置 `stop_grace_period: 30s`，覆盖总预算并留出余量。不要用更短的 `docker stop -t`、编排级 timeout 或脚本级超时停主服务。
3. 升级走 `./deploy.sh deploy`（或 `up -d`）：只重建 rcs 容器，Collector/OO 作为独立项目继续运行，旧容器同样按 30s 宽限期退出并刷新最后一批遥测。
4. 验收：down 前发出带唯一标记的请求/日志；down 后确认输出没有 `137/SIGKILL` 警告，并在 OO 的 `fenix_logs` 用该标记查到 `宿主资源清理结束`，同 Trace 的 Span 可在 Trace 页查到。退出码非 0 的警告按 rcs 日志中的关闭阶段错误处理；出现强杀时先核对停止预算、Collector 可达性与慢请求。
5. `--purge-data` 只在所有容器停止后删除数据目录；观测依赖未停时不要手工删除 `docker/*/data`。

### 已知限制

1. 请求排空超过 5s 只记 WARN（`请求排空超过`），关闭流程继续且退出码通常仍为 0；`deploy.sh` 只识别容器退出码 137/非 0，无法自动发现这类超时。验收时在 rcs 日志里检索该关键字。
2. `SIGINT` / `SIGTERM` 处理器在 `startHostRuntime` 与 `app.listen` 之后才注册；启动完成前收到信号按默认行为终止，不走有界关闭与遥测 flush。启动阶段本身没有在途业务请求，但该窗口内的启动日志可能丢失。

## 8. 验收清单（A01–A26）

### 审查项对照（R01–R06）

| 编号 | 审查问题 | 当前处置 |
| --- | --- | --- |
| R01 | 容器停止宽限期小于应用关闭预算 | 已修：两份主服务编排的 `rcs` 均设 `stop_grace_period: 30s`，关闭预算见 §7 |
| R02 | 停止流程先停观测依赖，应用最后退出 | 已修：`docker/deploy.sh down` 先停应用并排空，再按 `OBSERVABILITY_STOP_ORDER` 停 Collector → OO，见 §7 |
| R03 | 匿名请求可耗尽浏览器上报配额 | 不适用：前端 OTel 已移除 |
| R04 | 浏览器属性缺少值域限制 | 不适用：前端 OTel 已移除 |
| R05 | 仅按首次部署步骤启用 endpoint 会把生产标记为 development | 已修：生产编排默认注入与首次部署均要求显式环境名，见 §2 第 6 条 |
| R06 | 标准发布流程无法产出启用浏览器观测的镜像 | 不适用：前端 OTel 已移除 |

状态口径：**代码级**＝仓库内已有实现或局部测试，只证明代码行为；**待运行环境**＝必须在目标部署补齐真实证据；**不适用**＝本 PR 范围外。代码级不等于上线放行，所有运行项完成 §9 门禁并附证据后才能判为通过。本表是仓库内的权威版本，不依赖仓库外设计稿。

| 编号 | 验收场景 | 放行证据要求 | 当前状态 |
| --- | --- | --- | --- |
| A01 | 两套 Compose 静态配置可解析，启用的 `--config` 组合引用完整 | 目标机 `docker compose config --quiet` 通过；`validate` 传入与运行完全相同的全部配置 | 代码级 |
| A02 | 生产镜像使用统一 Bun 版本，workspace 依赖可装载且只有一个 SDK Provider | 最终发布镜像（记录 digest 与架构）启动；三信号、PG/Pino/ioredis hooks 生效；Bun 版本与 CI 一致 | 代码级 |
| A03 | Trace/Metric/Log 三信号经 Collector 写入目标 OO 并可查询 | 普通请求同时产生三类数据；可按 service/environment 查询；记录 stream、字段与时间 | 待运行环境 |
| A04 | HTTP 请求计数、状态码与路由模板正确 | 已知 2xx/4xx/5xx 请求集的 count 与状态维度一致；未知路由不使用原始 URL 维度 | 代码级 |
| A05 | HTTP Span 与异常/SSE 生命周期 | 异常请求产生 error Span；SSE 完成/取消计时正确；请求结束后无残留 Span | 代码级 |
| A06 | 日志唯一性与 Trace 关联 | 无故障时 N 条唯一日志得到 N 条；日志与 Trace ID 可在 OO 关联 | 代码级 |
| A07 | 日志脱敏 | stdout、本地文件与 OO 均无 SQL、参数、连接串、Cookie、正文与凭据；诊断字段保留 | 代码级 |
| A08 | PG 查询/等待/错误与连接池指标 | 与驱动真实状态一致；无 SQL/参数泄漏；每目标仅一个采集者 | 代码级 |
| A09 | ioredis 前后台任务与错误指标 | 自动插件生效；无连接串/命令参数泄漏 | 代码级 |
| A10 | 采样不影响指标 | 采样 1 与 0.1 对比：Trace 数变化而指标 count 不变 | 代码级 |
| A11 | 指标/日志命名与 OO 实际映射 | 用已知样本核对实际 stream/label/单位；按结果修正映射表，不改业务名称 | 待运行环境 |
| A12 | 主机指标与宿主读数一致 | host receiver 与 `top`/`df`/`/proc` 比对；容器数据不冒充宿主机 | 待运行环境 |
| A13 | 容器指标与无 Redis 场景 | 与 `docker stats` 一致；未部署 Redis 时不加载 Redis receiver、不误告警 | 待运行环境 |
| A14 | 同步积压、ACK 与断连释放 | 积压/outstanding/unacked 随负载增减并回落；ACK 时长准确；dispose 后引用释放 | 代码级 |
| A15 | 历史恢复与快照耗时/大小 | 恢复完成/失败各一次；耗时以提交且可读代次为准；不扫描历史 | 代码级 |
| A16 | Agent 启动/退出/失败/取消分类 | 每代次只记一次；引擎类别限于内置与 other/unknown；实例 ID 不作标签 | 代码级 |
| A17 | 浏览器上报链路 | 不适用：前端 OTel 已移除；R03/R06 随该能力关闭 | 不适用 |
| A18 | 浏览器属性与身份隔离 | 不适用：前端 OTel 已移除；R04 随该能力关闭 | 不适用 |
| A19 | OO 停止 10 分钟与恢复 | 业务继续服务；Collector 按容量缓冲；恢复后按预算回放；记录丢失窗口 | 待运行环境 |
| A20 | Collector 带积压重启 | SIGTERM 后队列落盘并可恢复；重启后不重复/不丢已接收数据（记录边界） | 待运行环境 |
| A21 | 队列满、磁盘不足、出口 401 | 业务不受影响；拒绝/入队失败/401 可观测；限频与丢弃有日志；不放宽为无界 | 待运行环境 |
| A22 | 正常关闭与强杀 | SIGTERM 有界刷新；唯一退出日志可在 OO 查到；无 137/SIGKILL；强杀允许丢内存数据 | 代码级 |
| A23 | 多实例与重启身份 | `service.instance.id` 每进程唯一；多实例不串数据；累计 Counter 用 rate/increase | 代码级 |
| A24 | 直方图桶与 P95 | 显式桶边界正确；目标 OO 的 count/sum/bucket/P95 与注入样本一致 | 代码级 |
| A25 | SDK 关闭 | `OTEL_SDK_DISABLED=true` 时业务照常、无导出、不尝试 localhost | 代码级 |
| A26 | 性能与成本 | 同负载开/关对比吞吐、P95、CPU/RSS、退出耗时；P95 成本预算 5%；核对成本预算 | 待运行环境 |

R03/R04/R06 与 G05 均随前端 OTel 移除关闭；若后续恢复浏览器观测，必须重新设计认证、Origin 信任、限流与身份隔离，并重做 A17/A18 与 G05。R01（停止宽限期）与 R05（部署环境）的配置口径见 §7 与 §2。

## 9. 运行验收门禁（G01–G07）

本节门禁必须在目标环境执行并保存证据；仓库当前**没有任何一项运行验收通过**，不得以 CI 全绿、容器 running 或 HTTP 200 代替。记录至少包含：应用 SHA、最终镜像 digest、Bun/Collector/OO 版本、配置版本、测试时间与输入、Collector 接收/出口数据、OO 查询结果。

| 门禁 | 必需证据 | 当前状态 | 证据记录（上线时填写） |
| --- | --- | --- | --- |
| G01 实际生产镜像 | 最终镜像在目标架构启动；Bun 1.4.3 与 CI 一致；workspace 依赖、单一 Provider、三信号与 PG/Pino/ioredis hooks 正常 | 未执行（版本已统一，镜像待构建/启动） | 待填 |
| G02 真实入库语义 | 普通请求与 4xx/5xx/SSE；日志与 Trace ID 关联；N 条唯一日志；直方图 count/sum/buckets/P95；PG/Redis 成功与失败 | 未执行 | 待填 |
| G03 故障与关闭 | OO 停止后恢复、Collector 带积压重启、401、队列满/磁盘不足、SIGTERM；业务持续可用与恢复边界 | 未执行 | 待填 |
| G04 基础设施 | 启用实际需要的 receiver、最小权限账号与挂载；宿主/容器/DB 读数比对；无 Redis 不误告警 | 未执行 | 待填 |
| G05 浏览器 | 不适用：前端 OTel 已移除（R03/R04/R06 关闭） | 不适用 | 不适用 |
| G06 告警闭环 | 校准 OO 字段与单位；配置通知目标并启用规则；注入故障验证触发与恢复；OO 不可用时独立探测通知 | 未执行（模板 9 条全禁用、destinations 为空，见 §10） | 待填 |
| G07 成本与回退 | 开/关吞吐、P95、CPU/RSS、退出耗时；成本预算；SDK 关闭与镜像回退 | 未执行（浏览器入口不适用，其余待验） | 待填 |

## 10. 告警模板启用（G06）

1. `docker/openobserve/assets/alerts.json` 是模板：当前 9 条规则全部 `enabled=false`，`destinations` 全为空。仓库状态不代表任何告警已启用或已送达。
2. 上线前在目标 OO 校准 stream/字段/单位/环境/时区与阈值，为每条规则配置通知目标，再逐条启用。
3. 启用前自检（模板阶段两条 `-e` 均以退出码 1 失败，属预期；`jq` 是已有工具，不新增运行时依赖）：

   ```bash
   jq 'length' docker/openobserve/assets/alerts.json
   jq -e 'all(.[]; (.destinations | length) > 0)' docker/openobserve/assets/alerts.json
   jq -e 'all(.[]; .enabled == true)' docker/openobserve/assets/alerts.json
   ```

4. `jq` 通过只证明文件字段齐全，不证明通知可用：逐条注入故障确认触发，恢复后确认告警解除；另用独立探测验证 OO 自身不可用时仍能通知（§4 第 4 条）。
