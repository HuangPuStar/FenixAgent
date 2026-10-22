# 独立节点：Collector

1. 本目录为自包含 Compose 单元，只用项目默认网络，不创建或依赖主服务网络。
2. 复制 `.env.example` 为 `.env`，填写真实主机身份、唯一 Collector 实例 ID、远端 OO HTTPS endpoint 与独立采集凭据；默认示例中的 Docker DNS 仅同机有效，独立节点必须替换。Compose 的 `env_file` 指向 `.env`，缺失时 `docker compose config` 会直接失败。
3. 创建 `./data/storage` 并授权 UID/GID 10001。状态、队列和 offset 不可随重建丢弃。
4. 执行 `docker compose config --quiet`，再执行与启动相同配置集合的 `validate`；固定镜像为 `0.163.2`。
5. 本机应用用回环 4318；浏览器同源代理用回环 4319。其他主机不可直接访问回环，跨机需受控 TLS 入口。
6. 主机/PG/Redis/Docker 配置均已随目录交付，但不自动加载。按本节点权限添加只读挂载和 `--config`，Redis 不存在时不要加载 receiver。
7. Docker socket 的 `:ro` 不限制 API 操作，必须用受限代理。Linux hostfs 不代表 Docker Desktop 物理 Mac。
8. 三信号各 256MiB 队列、最多 30 分钟重试，不承诺无限缓冲或恰好一次。升级保持组件 ID/路径，回滚先确认持久状态兼容。
