# Office 编辑部署与验收

## 配置

1. 文本和 Markdown 不需要文档服务。启用 Office 时，主服务只增加 `ONLYOFFICE_PUBLIC_URL` 和 `ONLYOFFICE_JWT_SECRET`；密钥至少 32 个字符，用 `openssl rand -hex 32` 生成，并与文档服务一致。
2. 配置已有的 `RCS_BASE_URL` 为文档服务能访问的主服务地址。浏览器及主服务必须能访问同一个 `ONLYOFFICE_PUBLIC_URL`。回源基址不从浏览器 Host 或代理头推导。
3. 反向代理同时转发 `/office/*`，屏蔽访问日志中的 token 路径，禁止缓存回源响应；不要对这两个协议入口追加浏览器登录跳转。浏览器控制接口仍走原有 `/web` 认证。
4. 未配置 Redis 时仅支持单个服务进程；多进程部署必须使用既有 `RCS_REDIS_URL`，所有实例共享同一服务密钥及 Redis。

## 可选 Compose

生产示例位于 `docker/onlyoffice/`，数据全部保存在该目录的 `data/`。主服务项目先创建 `fenix-server` 网络。按 [组件说明](../../docker/onlyoffice/README.md) 配置后启动；仓库根的开发编排另提供 `onlyoffice` profile。

镜像固定为 `onlyoffice/documentserver:10.0.0.1`。保留原有产品标识。文档服务从 7.0 起默认启用 `services.CoAuthoring.server.assemblyFormatAsOrigin=true`，定制镜像不得关闭，否则 ODF/RTF 保存将因格式不符被拒绝。[官方保存格式说明](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/saving-file/)

### 文字选区引用插件

1. 开发 Office Compose 直接只读挂载 `packages/file-editing/office-plugin`；生产在 `docker/onlyoffice/` 执行 `sh ./install-quote-plugin.sh`，把四个资源复制到组件自身的 `plugins/conversation-quote/` 后只读挂载。容器目标均为 `/var/www/onlyoffice/documentserver/sdkjs-plugins/{F38A98E2-B103-4F85-A572-03DF251BB15F}`。不替换提供方源码，不增加环境变量。
2. 使用外部文档服务时，将源目录中的 `config.json`、`index.html`、`selection.js`、`main.js` 安装到同一插件目录。浏览器必须能通过 `ONLYOFFICE_PUBLIC_URL` 访问其 `config.json` 和脚本；反向代理须转发 `/sdkjs-plugins/*`。独立分发 Compose 时须包含已安装的 `plugins/`；升级时重新安装资源并重开文档。
3. 主服务在签署编辑器初始化配置前声明插件 GUID、配置 URL 和自动启动；升级后重新打开文档加载新配置。静态插件文件不含平台密钥、文件读写令牌或用户信息。
4. 插件只扩展原右键菜单并读取所选文字，不改文档、不保存、不写批注。插件缺失或读取失败时应排查浏览器静态请求和控制台，不能通过放开 iframe 隔离或引入外部 Automation API 绕过。
5. 提供方对静态资源使用长期缓存；修改插件资源时同步递增 `config.json` 的 `version` 与 variation URL 中的 `v`。宿主配置和插件脚本沿用该版本参数，升级后重开文档即可加载新资源。
5. 验收 Word/PPT 文字选区与 Excel 单元格显示值、公式、空值、多行范围；整行/整列等超大区域提示缩小选区。选中图片或无文字形状不生成文字引用。还需确认原菜单、保存、刷新和关闭仍可用。

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
