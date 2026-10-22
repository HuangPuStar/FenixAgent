# Collector 独立部署

1. 本目录是 `otel-collector` 唯一生产入口，无跨项目 `depends_on`。同机连接由主服务创建的 `fenix-server`，只让 `otel-collector` 进入共享网络。
2. 复制 `.env.example` 到本目录 `.env`，填写主机真实身份、Collector 实例身份、OO 组织 endpoint 和独立采集凭据。Compose 的 `env_file` 指向该文件，执行 `docker compose config` 前必须先复制，否则静态校验直接失败。凭据不得打印或写进 Git；应用不持有 OO 凭据。
3. 创建 `./data/storage`，授予 UID/GID `10001:10001` 写权限。配置缺失不自动创建目录；数据必须有不少于 5 GiB 余量。
4. 基础入口加载 `collector.yaml` 和浏览器隔离配置。4318 供应用，4319 只供内网同源代理，13133 为存活探测，8888 为自身指标；宿主仅发布回环端口。TLS 反代必须把应用 `RCS_BASE_URL` 配成浏览器看到的单个 HTTPS origin；为空、非法或 localhost 时 `/otel` 会告警并 fail-closed，且不信任 `X-Forwarded-*`。

## 校验与启动

```bash
docker compose config --quiet
docker compose pull
docker compose run --rm otel-collector validate --config=/etc/otelcol-contrib/collector.yaml --config=/etc/otelcol-contrib/collector.browser.yaml
docker compose up -d
```

不得把 `compose config` 当成 Collector schema 或数据验收。镜像没有 shell/curl/wget 健康检查假设；由宿主探测 13133，并检查出口失败、入队失败和队列容量。

## 按需采集

在**本目录同一份编排**中添加对应 `--config` 与只读配置挂载，不叠加其他 Compose 项目。

| 配置 | 前置条件与新增挂载 |
| --- | --- |
| `collector.host.yaml` | Linux 宿主 `/` → `/hostfs:ro`；按挂载传播需求配置；`HOST_ID/HOST_NAME` 必须是真实主机而非 Collector 容器 |
| `collector.postgresql.yaml` | 独立只读监控账号、数据库白名单、TLS；仅指定一个采集者。统计权限由 DBA 授予，不复用应用写账号 |
| `collector.redis.yaml` | 仅部署 Redis 时启用，独立 ACL 账号允许 INFO 等监控命令；TLS 默认开启 |
| `collector.docker.yaml` | `DOCKER_MONITOR_ENDPOINT` 指向受限只读 Docker API 代理；不要直接把 socket 当作只读权限边界 |
| `collector.filelog.yaml` | 外部组件日志目录 → `/var/log/fenix-external:ro`；已显式 `start_at: end` 放弃存量，回读需先评估容量；应用主日志/错误日志/旧 sync-close 均排除 |

PG/Redis 无 TLS 的本机开发环境只能在审查网络隔离后显式修改 `tls.insecure`；生产不要关闭证书校验。Docker Desktop 数据属于 Linux VM，不代表物理 Mac 全部资源。

浏览器 pipeline 重置全部 Resource/Scope 身份、只接受 `fenix.web.*` 名称和有限维度；原始日志文本、Span 名称/事件/链接都不信任。浏览器属性不决定 OO 组织或访问权限。

## 故障与升级

1. 三个出口各 256 MiB 持久队列，重试最多 30 分钟；达到容量会丢弃，接收成功不等于已永久写入 OO。
2. 升级前用目标版本校验完全相同的配置集合，记录镜像 digest，执行三信号、直方图和带积压重启验收。
3. 保留 receiver/exporter ID、`./data`、挂载路径及 offset；修改它们可能造成回读或遗漏。
4. 回滚恢复已验证镜像与配置，并核查持久状态兼容；不要删除 `./data`。完整流程见 [运维手册](../../docs/operations/observability.md)。
5. 独立机器使用自包含交付文件 `deploy/otel-collector/`，不假设 `fenix-server` 存在。
