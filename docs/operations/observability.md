# 标准观测运维手册

## 1. 发布前检查

1. 应用基线与冻结版本见 `docs/design/observability-implementation.md`；镜像 tag 是候选运行组合，不代表已通过真实数据验收。上线记录应用 SHA、Bun 版本、三类镜像 digest、配置版本和目标 CPU 架构。
2. 数据目录都在各自编排的 `./data`；Collector 为 UID/GID 10001 创建 `data/storage`，至少预留 5GiB。OO 需核实镜像运行用户与数据权限。
3. 凭据由秘密管理器或不入库 `.env` 注入。OO root 初始化与 Collector 采集凭据分开，应用和浏览器不接收 OO 凭据。
4. feature 只控制本目录：`FENIX_FEATURE_OTEL_COLLECTOR`、`FENIX_FEATURE_OPENOBSERVE` 默认关闭，由目录发现/环境生成器登记，不会互相启用。

## 2. 首次部署

1. 主服务先创建 `fenix-server`。分别准备 `docker/openobserve/.env`、`docker/otel-collector/.env` 和数据权限；两套 Compose 都要求同目录 `.env`（Collector 经服务 `env_file`，OO 经 Compose 变量插值），必须在执行 `docker compose config` 前从 `.env.example` 复制并填写，否则静态校验会报 `.env not found` 或缺少必填变量。
2. 各目录执行 `docker compose config --quiet`。拉取 OO 固定镜像后初始化管理员、组织与独立采集凭据。
3. Collector 的 `OO_OTLP_ENDPOINT` 指向 `/api/<组织>`，无尾斜线；`OO_AUTH_HEADER` 由 OO 接入页取得，不在终端/报告中打印。
4. `docker compose run --rm otel-collector validate` 必须传与运行相同的所有 `--config`。基础含 browser 隔离配置；按需要加 host/PG/Redis/Docker/filelog。
5. 启动 Collector 后独立探测 13133；核对 8888 指标的拒绝、发送失败、队列占用。不要以容器 running/HTTP 200 代替数据健康。
6. 应用设置 `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`，联调采样率 1；生产初始 0.1，指标不随采样下降。浏览器代理设置 `OTEL_BROWSER_COLLECTOR_ENDPOINT=http://otel-collector:4319`。
7. TLS 在反向代理终止时，必须在应用环境设置浏览器看到的 `RCS_BASE_URL=https://<公开域名>`；`/otel` 以该值的唯一 origin 校验 `Origin`，不信任 `X-Forwarded-Host/Proto`。启用浏览器遥测时，该值为空、非法或 localhost 会在启动期输出明确告警并 fail-closed（拒绝全部 `/otel` 请求）；缺失或跨站 Origin 返回 403。单进程只支持一个公开 origin。
8. `/otel` 复用普通认证链：session cookie、Environment Secret、API Key。浏览器只依赖同源 session cookie；Environment Secret/API Key 是受控服务端调用方的备用入口，不是下发给浏览器的采集凭据。
9. 代理当前还有一个全局在飞上限（8）与单用户在飞上限（2）。全局 8 个慢批次可能造成短暂 429；若业务浏览器流量增大，优先按 `browser-proxy.ts` 常量与入口速率调整，并同步压测 Collector 4319，不要只调大单值。
10. 浏览器镜像构建时传 `VITE_OTEL_ENABLED=true` 与版本。它是构建配置，不是仅重启容器即可改变的服务端运行变量。未开启则页面不安装 SDK。
11. 部署资产统一位于 `docker/openobserve/`、`docker/otel-collector/`，各自自包含编排、配置和 `assets/`。跨机部署时整目录拷贝，目标机先创建同名外部网络 `docker network create fenix-server`；跨机使用受控 HTTPS，Docker 服务名不能跨主机。

## 3. 数据语义验收

完整 A01–A26 见设计原文。每次记录输入、时间、配置与版本、Collector 状态和 OO 查询结果。

1. 普通请求、400/404/500、异常、SSE 完成/取消：日志与 Trace ID 一致，直方图计数/状态/路由正确，Span 不残留。
2. 用已知请求数比较采样 1/0.1：Trace 数变化，指标 count 不变；注入已知耗时样本检查 count/sum/累计桶/P95。
3. PG 查询/等待/错误与 ioredis 前后台任务：自动插件生效，池状态与驱动真实状态一致；无 SQL、参数、连接串、Cookie、正文泄漏。
4. 无故障时 N 条唯一日志得到 N 条；stdout、本地与 OO 都检查禁止字段；Observer 原日志页面仍可读。
5. 主机/容器数据与宿主工具比对。Mac Docker Desktop 只代表 VM/容器；未部署 Redis 就不加载 Redis receiver。
6. 同步积压/ACK 后回落、断连释放、恢复完成/失败、快照耗时大小与既有信号一致；不扫描历史，不保留销毁 scope。
7. Agent 启动/退出/失败/取消结果每代次只记一次；多实例与重启身份正确。
8. 浏览器异常/API/恢复经同源路径进入 4319；上报不递归，伪造宿主/组织/metric 属性不能污染服务端数据。
9. OO 停止 10 分钟、Collector 带队列重启、队列满/磁盘不足/401：业务继续服务，已持久数据按预算恢复，丢失窗口明确。
10. SIGTERM 有界刷新；强杀允许丢 SDK 内存。禁用 SDK 时业务照常；同机同负载对比吞吐/P95/CPU/RSS/事件循环，初始 P95 成本预算 5%。

## 4. 看板与告警

1. `docker/openobserve/assets/` 保存四类候选看板、规则和映射；先校准 OO 实际指标名/属性/单位再导入。命名转换只改部署资产，不改业务 OTel 名称。
2. 所有看板筛环境/服务/时间；应用看板不包含 fenix-web。缺数据单独显示，不能当成零错误。累计 Counter 用 rate/increase 处理重启。
3. 5xx 5分钟 >5% 且至少100请求、P95 >2秒、池等待、同步积压、恢复失败、队列 >80% 持续5分钟、拒绝数据与磁盘 <15% 为起点。
4. 服务不可达2分钟和 OO/Collector 入口不可达由独立探测通道通知；OO 自身宕机不能依靠 OO 发告警。

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
| Collector 拒绝/内存限制 | 查批大小、浏览器允许列表、1MiB上限、receiver错误；不要无界放宽 |
| 出口401 | 校验组织/独立采集凭据，轮换秘密，不打印 Header |
| 队列持续增长 | OO 可达性/写入、磁盘权限与空间；修复后确认排空，警惕故障重放重复 |
| PG/Redis 来源重复 | 每目标保留一个 receiver 采集者；客户端埋点不等于服务端统计 |
| 浏览器403/401/415/429 | Origin、平台会话、protobuf/无压缩、速率；不能透传浏览器凭据到 Collector |
| 回滚应用 | 先 `OTEL_SDK_DISABLED=true`，或回退应用镜像；业务协议与数据库无变化 |
| 回滚 Collector/OO | 恢复匹配配置/镜像并确认状态兼容；OO 必要时恢复一致性备份，绝不删除 data |
