# 独立观测主机：OpenObserve

1. 本目录完整交付，不引用主服务 `fenix-server`；只使用 Compose 项目默认网络。
2. 复制本目录 `.env.example` 为 `.env`，填写管理员初始化信息；创建并授权 `./data`。
3. `docker compose config --quiet` 后拉取固定镜像并启动。默认只发布回环 5080，由本机既有 HTTPS 入口代理。
4. Collector 的 endpoint 使用此主机受控 HTTPS 入口与目标组织；不能使用另一台机器的 Docker DNS。
5. 采集凭据与管理员初始化密码分离。停写后备份 `./data`，升级前做恢复演练；不可逆存储迁移不能仅回退镜像。
6. 本目录 `assets/` 自带与本机部署同内容的四类看板和告警模板；上线前先按目标 OO 实际入库字段校准，再导入。完整流程见仓库 `docs/operations/observability.md`。
