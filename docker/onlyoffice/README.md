# OnlyOffice Docs（可选）

1. 主服务项目先启动并创建 `fenix-server` 网络。
2. `cp .env.example .env`，填写与主服务相同的 `ONLYOFFICE_JWT_SECRET`。
3. 在完整仓库内执行 `sh ./install-quote-plugin.sh`，将引用插件安装到当前目录的 `plugins/conversation-quote/`。
4. `docker compose up -d`，`docker compose ps` 确认健康。
5. 通过反向代理公开统一域名，主服务设置 `ONLYOFFICE_PUBLIC_URL`；配置文档服务可达的已有 `RCS_BASE_URL`。

本地端口为 `127.0.0.1:8088`，镜像固定 `onlyoffice/documentserver:10.0.0.1`。数据、日志、数据库保存在当前目录 `data/`，不依赖其他目录的配置或数据。JWT 不提供默认密钥。

右键“添加到对话”的资源源文件归 `packages/file-editing/office-plugin`，安装后由当前目录只读挂载。仅分发本目录时，先安装再整体拷贝（包含 `plugins/`）；也可在目标机运行 `sh ./install-quote-plugin.sh /path/to/office-plugin`。升级时重新安装资源并重开文档。插件安装、反向代理与验收见 [文字选区引用插件](../../docs/operations/office-editing.md#文字选区引用插件)。

原格式输出沿用镜像默认 `assemblyFormatAsOrigin=true`；定制镜像必须保留。双向网络、机器升级、各格式验收与回滚见 [运维说明](../../docs/operations/office-editing.md)。
