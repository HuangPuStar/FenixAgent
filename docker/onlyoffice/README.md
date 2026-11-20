# OnlyOffice Docs（可选）

1. 主服务项目先启动并创建 `fenix-server` 网络。
2. `cp .env.example .env`，填写与主服务相同的 `ONLYOFFICE_JWT_SECRET`。
3. `docker compose up -d`，`docker compose ps` 确认健康。
4. 通过反向代理公开统一域名，主服务设置 `ONLYOFFICE_PUBLIC_URL`；配置文档服务可达的已有 `RCS_BASE_URL`。

本地端口为 `127.0.0.1:8088`，镜像固定 `onlyoffice/documentserver:10.0.0.1`。数据、日志、数据库保存在当前目录 `data/`，不依赖其他目录的配置或数据。JWT 不提供默认密钥。

原格式输出沿用镜像默认 `assemblyFormatAsOrigin=true`；定制镜像必须保留。双向网络、机器升级、各格式验收与回滚见 [运维说明](../../docs/operations/office-editing.md)。
