# Office 编辑部署与验收

## 配置

1. 文本和 Markdown 不需要文档服务。启用 Office 时，主服务只增加 `ONLYOFFICE_PUBLIC_URL` 和 `ONLYOFFICE_JWT_SECRET`；密钥至少 32 个字符，用 `openssl rand -hex 32` 生成，并与文档服务一致。
2. 配置已有的 `RCS_BASE_URL` 为文档服务能访问的主服务地址。浏览器及主服务必须能访问同一个 `ONLYOFFICE_PUBLIC_URL`。回源基址不从浏览器 Host 或代理头推导。
3. 反向代理同时转发 `/office/*`，屏蔽访问日志中的 token 路径，禁止缓存回源响应；不要对这两个协议入口追加浏览器登录跳转。浏览器控制接口仍走原有 `/web` 认证。
4. 未配置 Redis 时仅支持单个服务进程；多进程部署必须使用既有 `RCS_REDIS_URL`，所有实例共享同一服务密钥及 Redis。

## 可选 Compose

生产示例位于 `docker/onlyoffice/`，数据全部保存在该目录的 `data/`。主服务项目先创建 `fenix-server` 网络。按 [组件说明](../../docker/onlyoffice/README.md) 配置后启动；仓库根的开发编排另提供 `onlyoffice` profile。

镜像固定为 `onlyoffice/documentserver:10.0.0.1`。保留原有产品标识。文档服务从 7.0 起默认启用 `services.CoAuthoring.server.assemblyFormatAsOrigin=true`，定制镜像不得关闭，否则 ODF/RTF 保存将因格式不符被拒绝。[官方保存格式说明](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/saving-file/)

1. 宿主源码开发可将文档服务发布到 `http://localhost:8088`，主服务回源地址需要使用容器能解析的宿主地址（例如 `http://host.docker.internal:3000`）。
2. 容器部署应使用浏览器、主服务和文档服务均可解析的统一域名。`http://onlyoffice` 仅容器内可用，不能直接作为浏览器地址；`localhost` 在文档服务内指向其自身。
3. Compose 允许文档服务回源私网地址，以支持内网主服务；应在部署网络限制其出口，仅允许主服务所需网段。元数据地址仍禁用。
4. 健康接口为 `/healthcheck`；还要验证浏览器脚本 `web-apps/apps/api/documents/api.js`、主服务回源及保存回调的双向连通，健康检查不能替代保存验收。

## 升级与回滚

1. 先升级机器运行产物，使 file-ws 注册声明 `uploadOverwrite`、`contentVersion`；旧节点上 Office 编辑不启用，条件文本保存也明确报错。
2. 服务端和机器都保持默认上传不覆盖。调用方只有显式 `overwrite=true` 才会替换文件；编辑保存始终带 `expectedVersion`。
3. 回滚前让用户保存或放弃会话，停止新会话并等待在途写入结束。未配置持久共享存储时重启会失去编辑控制状态，旧回调会被拒绝，不恢复无条件写入。
4. 禁用两项 Office 配置后回到只读 Office 预览，文本编辑继续可用。移除提供方时不删除已有工作区文件，无数据库回滚步骤。

## 验收

每次更换文档服务镜像都应分别验证 docx、xlsx、pptx、odt、ods、odp、rtf：打开、修改、保存到工作区、关闭、重新打开，并检查输出扩展名与真实内容格式。未通过的类型不能宣称已完成提供方验收。

还需验证：同大小外部修改触发冲突；删除后不重新创建；覆盖确认后的二次冲突；本地及远端写回；重复 saveId；保存回执丢失；放弃/过期后的迟到回调；断连重连；多实例共享 Redis；令牌与密钥不出现在访问日志中。包内假提供方测试只验证契约，不等价于真实文档服务与真实远端验收。
