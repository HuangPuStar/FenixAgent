# FenixAgent 标准观测契约

## 1. 所有权与协议

1. `apps/server/src/telemetry/` 是唯一服务端 SDK 装配入口；业务包仅调用 `@opentelemetry/api`，不持有 exporter、OO URL 或 Provider。
2. 应用只用 OTLP/HTTP Protobuf 连接 Collector；OO 组织、凭据、流路由只在 Collector 出口出现。Langfuse/Peri-Fuse 继续负责模型与工具明细。
3. `entry.ts` 初始化 SDK 后动态导入 `main.ts`。生产 Bun 构建启用 `--splitting --packages=external` 并显式外置 `@fenix/logger` 及其子路径，运行镜像携带同一份依赖与 workspace，不能将入口改回直接加载 main。
4. Bun 的 ESM import 不采用 Node require hook 返回值。初始化入口经社区插件加载 PG/pg-pool/ioredis/Pino 后写回同一模块缓存，不复制插件协议或自建遥测传输。

## 2. 生命周期与资源

1. 没有 exporter endpoint 或 `OTEL_SDK_DISABLED=true` 时 No-op，不尝试 localhost。显式启用后的非法配置是部署错误；后端不可达不影响业务就绪。
2. 只有一个 Resource 与 Trace/Metric/Log Provider。`service.version` 取 build info，`service.instance.id` 每进程唯一；部署只能指定 namespace、环境和可信主机身份。
3. W3C trace context 与业务 request ID 分离；不传播未经审查的 Baggage，不将 trace ID 用于认证、授权或幂等。
4. 关闭顺序为停止入口、清理业务、最后日志、SDK shutdown；`app.stop(false)` 只调用一次，5s 超时后不重复 stop，完成宿主清理后显式退出；重复信号共享 Promise，遥测退出总预算 5 秒。
5. 服务端 traces/logs 使用 batch queue，队列 1024、批量 128、单次网络超时 3 秒；metrics 使用 periodic export，导出间隔由 `OTEL_METRIC_EXPORT_INTERVAL` 配置。累计显式桶指标。HTTP 桶复用官方插件 advice，不创建第二套请求计时器。
6. 所有 `OTEL_*` 字符串空白值统一视为未配置并取默认值，不能靠显式空串改变语义。`OTEL_NODE_ENABLED_INSTRUMENTATIONS` 空白即恢复默认 `pg,ioredis,pino`；本项目不采用“空串=禁用全部自动埋点”的隐式语义。需要关闭某类导出时使用标准 `OTEL_*_EXPORTER=none`。

## 3. 字段与指标

1. Pino `msg` 是描述，业务对象保留独立字段；`level` 为 Pino 标准数字，`levelLabel` 是阅读投影。stdout/文件/OTel 分流之前统一脱敏，错误不展开 SQL/params/cause 内容。
2. 消息不超过 8KiB、普通附加字符串 2KiB、嵌套 5 层、每对象/数组最多 32 项。禁止 token、Cookie、密码、连接串、prompt/completion、请求正文；自由文本调用方不得预先拼接正文。
3. `sync-close-diagnostics` 走统一日志，不再另写同步关闭文件。Observer 保留本地文件读取路径，filelog 不再采集同源主日志和错误副本。
4. HTTP 使用官方 Elysia 插件且只注册一次；采样不控制指标。未知路由不以原始 URL 作为指标维度。PG/ioredis 复用自动插件，SQL/参数/URL query 在导出前删除。
5. `fenix.sync.*` Gauge 只读取活跃 runtime 的 `transportDiagnostics()`；关闭/dispose 解除引用。ACK 使用已有 track 时钟；失败仅事件时 add；快照复用 CAS 耗时/编码长度；恢复完成以提交并可读取代次为准。
6. Agent 运行按代次幂等结算，活跃测量结束即删除。引擎只允许内置类别及 other/unknown，实例 ID 不作指标标签。
7. PG 插件提供 connection count/pending 与 operation duration。锁定版本不提供 max，宿主仅补 `db.client.connection.max`，不重复连接计数。
8. 所有自定义 Histogram 必须声明显式桶：秒级使用 5ms–3600s 边界，快照字节使用 1KiB–256MiB 边界。禁止依赖默认 `[0,5,10,…]`，否则亚秒与体积尾部全部落入首桶或 `+Inf`。

## 4. 前端边界

前端观测不在本次范围：不引入浏览器 SDK、同源浏览器上报代理、浏览器 Collector receiver/pipeline，也不下发浏览器采集凭据。后续若重启该能力，必须重新设计认证、Origin 信任、限流与资源身份隔离。

## 5. 部署边界

Collector/OpenObserve 独立工程、固定镜像、本目录 `.env` 和 `./data`；同机共享 `fenix-server`，跨机部署时在目标机创建同名外部网络。部署资产只在 `docker/` 下维护一份。无跨工程 `depends_on`，观测后端不是业务启动依赖。详见 [运维手册](../operations/observability.md)。
