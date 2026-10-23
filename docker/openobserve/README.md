# OpenObserve 独立部署

1. 本目录为 `openobserve` 唯一生产编排，不与主服务叠加 `-f`，也不引用其他工程的卷或 `depends_on`。
2. 同机由主服务创建 `fenix-server`，仅 `openobserve` 服务加入；Collector 经 `openobserve:5080` 访问，应用只连接 Collector。
3. 复制本目录 `.env.example` 为 `.env`，填写管理员初始化信息；数据预先创建于 `./data`，确认目标镜像运行用户有读写权限。真实配置不进 Git。
4. 宿主端口仅回环 5080；跨机由既有入口提供 HTTPS。跨机部署时整目录拷贝，目标机需先创建同名外部网络 `docker network create fenix-server`。

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
```

## 数据接入与资产

1. 在目标 OO 组织的数据接入页面创建独立采集凭据，仅给 Collector 配置；不要分发 root 管理密码。
2. OTLP 入口基址为 `/api/<组织>`，不加尾部 `/`；日志 exporter 指定 `fenix_logs`，Trace/Metric 用标准 OTLP 路由。
3. `assets/` 随本目录交付，保存四类看板、告警及指标映射。先用确定性样本验证实际映射，再导入；不能把候选映射当作已验证事实。
4. 初始保留建议：日志 14 天、Trace 7 天、指标 30 天；由存储容量、合规与实际流量校准。

## 升级、备份与回滚

1. 停止顺序固定为应用 → Collector → 本目录：Collector 的 SIGTERM 会把出口队列冲刷到 OO，OO 必须最后停。`docker/deploy.sh down` 已按此执行；两套 Compose 保持独立，不引入跨项目 `depends_on`。
2. 固定 `v1.1.2`；正式部署记录目标架构和拉取 digest。tag 存在不代表本项目运行组合已经验收。
3. 升级前保存看板/告警、独立备份凭据，并停止写入取得 `./data` 一致性备份；执行恢复演练。
4. 存储发生不可逆迁移时不能只回退镜像，应恢复匹配的数据备份。停止/重建容器不删除 `./data`。
5. root 初始化变量不是密码轮换入口；初始化后使用 OO 账号管理轮换。
6. OO 故障期间 Collector 仅在容量/重试时限内缓冲；存活与入口告警由独立探测通道承担。

详细验收、排障和回滚顺序见 [运维手册](../../docs/operations/observability.md)。
