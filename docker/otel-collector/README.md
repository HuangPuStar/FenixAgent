# Collector 独立部署

1. 本目录是 `otel-collector` 唯一生产入口，无跨项目 `depends_on`。同机连接由主服务创建的 `fenix-server`，只让 `otel-collector` 进入共享网络。
2. 复制 `.env.example` 到本目录 `.env`，填写主机真实身份、Collector 实例身份、OO 组织 endpoint 和独立采集凭据。`OO_OTLP_ENDPOINT` 为必填且模板留空：两栈同机并都接入 `fenix-server` 时可填 `http://openobserve:5080/api/default`；跨机必须填受控 HTTPS 地址（不带尾部斜线），Docker 服务名不能跨主机解析。Compose 的 `env_file` 指向该文件，`OO_OTLP_ENDPOINT=` 空值会以 `set OO_OTLP_ENDPOINT` 让 `docker compose config` 失败；执行静态校验前必须先复制并填写。凭据不得打印或写进 Git；应用不持有 OO 凭据。
3. 创建 `./data/storage`，授予 UID/GID `10001:10001` 写权限。配置缺失不自动创建目录；数据必须有不少于 5 GiB 余量。
4. 基础入口只加载 `collector.yaml`。4318 供应用，13133 为存活探测，8888 为自身指标；宿主仅发布回环端口。

## 校验与启动

```bash
docker compose config --quiet
docker compose pull
docker compose run --rm otel-collector validate --config=/etc/otelcol-contrib/collector.yaml
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

前端观测不在本次范围，Collector 不接收浏览器 OTLP。

## 故障与升级

1. 停止顺序固定为应用 → Collector → OO：应用退出时 Collector 必须仍在，Collector 收到 SIGTERM 后会冲刷出口队列，此时 OO 也必须仍在。`docker/deploy.sh down` 已按此执行；手工停止时不要先停本目录或 OO。两套 Compose 保持独立，不引入跨项目 `depends_on`。
2. 三个出口各 256 MiB 持久队列，重试最多 30 分钟；达到容量会丢弃，接收成功不等于已永久写入 OO。
3. 升级前用目标版本校验完全相同的配置集合，记录镜像 digest，执行三信号、直方图和带积压重启验收。
4. 保留 receiver/exporter ID、`./data`、挂载路径及 offset；修改它们可能造成回读或遗漏。
5. 回滚恢复已验证镜像与配置，并核查持久状态兼容；不要删除 `./data`。完整流程见 [运维手册](../../docs/operations/observability.md)。
6. 本目录自包含全部编排、配置与凭据模板，跨机部署时整目录拷贝即可；目标机需先创建同名外部网络 `docker network create fenix-server`，否则 Compose 会因网络缺失失败。
