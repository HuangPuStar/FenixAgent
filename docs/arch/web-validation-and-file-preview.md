# Web 参数校验与工作区文件预览

## 身份管理

- `POST /web/organizations` 的 `name`、`slug` 必须为非空白字符串，非法参数返回 400，错误信息包含对应字段名。
- BetterAuth 的 `ORGANIZATION_ALREADY_EXISTS`、`ORGANIZATION_SLUG_ALREADY_TAKEN` 在组织创建边界映射为 409，Web 错误码为 `ORGANIZATION_SLUG_ALREADY_TAKEN`。控制台据此展示本包的本地化提示；其他异常继续交由宿主错误处理器记录和处理。
- `POST /web/api-keys` 的 `expiresAt` 可省略，表示永久密钥；提供时须为可解析的时间字符串或毫秒时间戳，且严格晚于服务端当前时间。时间戳 `0` 是已过期时间，不能解释为省略。非法值返回 400 `VALIDATION_ERROR`，不调用下游创建接口。

## 发布视图

- 管理与加载路由的 `:id` 必须为 UUID；宿主将协议校验错误映射为 400。
- 合法 UUID 对应记录不存在时，详情路由显式返回 404 `NOT_FOUND`，不能让失败信封进入成功响应 schema。
- 详情、更新、删除与加载均保留 Facade 的组织范围约束。

## 工作区文件预览

工作区文件名是原始文件系统名称，不能按 URL 的 query 或 fragment 规则截断。`ui-components` 在预览插件适配边界依据原始名称恢复扩展名，向插件的匹配及渲染阶段分别提供元数据副本；不改变显示名、下载名、源 URL 或第三方共享对象。

PDF、HTML、表格、图片和文本继续复用既有插件。路径的 URL 编码由文件 API 层负责；插件适配不解码或重新编码源地址。HTML 渲染保持 `sandbox="allow-scripts"`，不放开同源权限。
