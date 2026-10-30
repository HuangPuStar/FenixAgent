# 个人云盘（CloudDrive）

> 状态：实现基线（2026-10-28，真实 CloudDrive demo 栈联调通过）。
> 归属：`packages/resources/cloud-drive`（`@fenix/resource-cloud-drive`）。
> 运维入口：[CloudDrive 本地联调与验收](../operations/cloud-drive-local-smoke.md)。

## 1. 定位与边界

Fenix 为每个登录用户提供独立的个人云盘。文件、目录、版本、回收站、搜索与配额全部由外部 CloudDrive 持有；Fenix **不建表、不落库、不缓存文件状态**，只作为受信任调用方代理 REST `/v1/*`。

| 能力 | owner |
| --- | --- |
| 文件/目录/版本/回收站/搜索/配额数据 | CloudDrive |
| master key、外部主体映射、空间 provisioner | CloudDrive 部署 |
| 会话认证、组织上下文 | 宿主 `apps/server` |
| `/web/cloud-drive/*` 协议面、TUS 代理、错误映射 | 本模块 |
| 控制台页面、语言资源与 `web` 贡献 | 本模块 `web/` |

模块 manifest：`id: "cloud-drive"` / `kind: "resource"` / `dependsOn: []` / 一条 `slot: "web"` 路由贡献。没有 `create()`、Repository 或 Domain Service——没有独立于远端调用的领域状态。

## 2. 信任边界与主体隔离

```text
浏览器 ──/web/cloud-drive/*（session cookie）──► Fenix 后端
Fenix 后端 ──Authorization: Bearer <master key>
             X-On-Behalf-Of: <Fenix userId>
             X-Key-Id: <可选> ─────────────────► CloudDrive /v1/*
```

1. `X-On-Behalf-Of` 只来自守卫写入的 `store.authContext.userId`（`routes/dependencies.ts` 的 `actorFromStore`）。路由参数、请求体、查询串没有用户标识字段，也没有进入 client 的通道。
2. client 的 `baseHeaders()` 是认证头的唯一生成点，调用方不能覆盖 `Authorization` / `X-On-Behalf-Of`。
3. subject 在发请求前按 CloudDrive 的规则校验（`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`）；不合法在 Fenix 侧直接失败，不把 400 变成上游 502。
4. 跨用户隔离由 CloudDrive 按 `(issuer, subject)` 分区保证：读取、删除、列表父目录、TUS 会话均按主体过滤，越权一律 `404 NOT_FOUND`。Fenix 侧只保证「永远是当前登录用户」。
5. master key 只存在于模块配置；响应、日志、错误文案都不包含它，也不向前端下发 CloudDrive 的 `upload_url`。

## 3. 数据与状态

- **无表**：本模块没有 `db/`、迁移或数据迁移；`drizzle.config.ts` 不声明它。
- **无本地缓存**：列表、元数据、配额每次实时请求 CloudDrive；搜索是最終一致的，刚写入的文件可能短暂搜不到。
- **幂等**：每个写操作由 Facade 生成新的 `idempotency_key`（`crypto.randomUUID()`），交给 CloudDrive 的写接口。浏览器重试 = 新 key = 新操作；跨请求续传靠同一个上传会话，而不是重复创建上传。
- **乐观并发**：改名/移动/删除/覆盖写需要 `expected_metadata_revision`（覆盖写还要 `expected_version_id`）。Facade 先 `GET /v1/files/{id}` 读当前值再提交；两次调用之间版本推进时上游返回 `VERSION_CONFLICT`，对外是 409。恢复是唯一例外：已进回收站的文件无法再读元数据，`expectedMetadataRevision` 由前端从回收站条目的 `file.metadataRevision` 带上。

## 4. 协议面

20 条 `/web/cloud-drive/*` 路由（`routes/web/`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me` | 主体与配额（上限 / 已用 / 预留） |
| GET | `/files?parentId=&cursor=` | 目录列表，游标分页 |
| GET | `/files/:id` | 元数据 |
| GET | `/files/:id/versions` | 历史版本 |
| GET | `/files/:id/content` | 流式下载，单段 Range，带文件名 |
| GET | `/files/:id/markdown?cursor=` | 转换产物的 markdown 一页，游标分页 |
| GET | `/files/:id/preview` | 栅格预览页清单（页数 / 页号 / 版本） |
| GET | `/files/:id/preview/pages/:page?versionId=` | 栅格页图 PNG（版本必填，缺省用当前版本） |
| POST | `/files/:id/conversions` | 重新排队转换（失败重试） |
| POST | `/directories` | 新建目录 |
| PATCH | `/files/:id/location` | 改名 / 移动（`parentId: null` = 根目录） |
| DELETE | `/files/:id` | 移入回收站 |
| GET | `/trash` | 回收站列表 |
| POST | `/trash/:id/restore` | 恢复 |
| POST | `/search` | 关键词搜索 |
| POST | `/uploads` | 创建 TUS 上传会话 |
| GET | `/uploads/:id` | 查询 offset / length |
| PATCH | `/uploads/:id` | 上传一个分片 |
| POST | `/uploads/:id/finalize` | 提交 |
| POST | `/uploads/:id/abandon` | 放弃 |

除二进制下载、页图与分片上传外，响应统一 `{ success: true, data }` / `{ success: false, error: { code, message } }`。DTO 在上游边界重写为 camelCase，并丢弃 `owner_id` / `space_id` / `native_*` / `reserved_location` / `operation_id` 等内部字段。

### 4.1 控制台页面（`web/`）

入口：侧栏「云盘」（`web/contribution.ts`，core 组 order 50）→ 宿主路由壳 `apps/web/src/routes/agent/_panel/cloud-drive.tsx`（懒加载 + Suspense）→ `CloudDrivePage`。目录层级是页面内状态（首版无 URL 深链）；`web/index.ts` 是浏览器安全入口，字典经 `web/i18n` 子路径登记到宿主 `cloudDrive` 命名空间。

- **列表 / 面包屑**：`GET /files`，游标分页「加载更多」；空态、失败态（`role="alert"` + 重试）与加载骨架分开呈现。
- **上传**：`web/lib/upload.ts` 的 `runChunkedUpload` 负责 4 MiB 切片、以服务端 `offset` 续传、网络/限流退避重试与 410 重建会话；React 队列（`web/hooks/use-cloud-drive-uploads.ts`）串行执行多文件、逐文件进度、失败重试与取消（取消会 `abandon` 会话）。队列以右下角浮层展示：全部完成后延迟 2s 自动隐藏，失败条目保持到重试或清除，新任务出现时重新显示。
- **下载**：同源锚点直连 `GET /files/:id/content`，文件名由服务端 `Content-Disposition` 决定，不经前端 blob。
- **预览**：文件行「预览」动作或点击文件名打开对话框（`CloudDrivePreviewDialog`）。文本/Office 走 markdown 并循环游标（一次最多 8 页 / 512KiB，可继续加载）；PDF/图片走页清单 + 页图，支持翻页、页码输入与适应宽度；其它类型提示下载。转换中显示进度并轮询元数据（退避、30s 预算、关闭即取消）；失败提供「重新转换」；404/413/429/503/502 都有可读文案与重试。
- **变更**：新建目录 / 改名 / 移动 / 删除 / 恢复都走既有端点；`expectedMetadataRevision` 只在恢复时由前端携带（取自回收站条目）。
- **搜索**：`POST /search` 手动触发；上游按 chunk 返回命中，服务端把同一文件聚合成一条、截取带上下文的纯文本片段并返回 UTF-16 高亮区间（每文件最多 3 段，默认 20 个文件、上限 50）。为补齐名称 / 父目录 / 大小 / 更新时间，只对实际展示的文件并发读取元数据（6 并发、2 秒总时限，失败回退路径派生值）；页面点击文件名或「打开所在目录」仍先 `GET /files/:id` 再逐级回溯目录名重建面包屑。
- **错误**：服务端信封 `message` 优先上屏，字典只在 message 为空时兜底；上传会话 410/404 停止续传。

## 5. TUS 上传代理

1. 浏览器只与 Fenix 通信。`POST /uploads` 由服务端生成 `idempotency_key` 并向 CloudDrive 预留会话，返回 `uploadId` / `fileId` / `operationId` / `status` / `expiresAt`。
2. TUS 地址由 `CLOUDDRIVE_BASE_URL` + `/v1/tus/{uploadId}` 构造，**不使用**上游返回的 `upload_url`：demo 栈的主机名是 `drive.localhost`，浏览器或容器内未必可达。
3. `PATCH /uploads/:id` 用 `parse: "none"` 读取原始 body；必须带 `Content-Length`（CloudDrive 拒绝 chunked）和 `Upload-Offset`；服务端固定 `Content-Type: application/offset+octet-stream` 与 `Tus-Resumable: 1.0.0`，并强制把实际字节数写入 `Content-Length`。响应体返回最新 `{ offset, length }`，同时回写 `Upload-Offset` / `Upload-Length` 头。
4. 单分片上限 64 MiB（CloudDrive 的 HTTP 硬上限），宿主全站 body 上限 108 MiB；前端建议 **4 MiB** 分片。
5. 已 finalize / abandon 的会话，上游 TUS HEAD 返回 409 `OPERATION_PENDING`；Fenix 将其翻译为 **410 `CLOUD_DRIVE_UPLOAD_GONE`**。不存在或跨用户的会话是 **404 `CLOUD_DRIVE_UPLOAD_NOT_FOUND`**。前端应停止轮询，finalize 本身是幂等的（`status=saved`）。

## 6. 下载

`GET /files/:id/content` 先读一次元数据（取文件名、拒绝目录），再打开内容流。上游只返回裸 `attachment`，Fenix 重写为：

```text
Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987>
```

- 透传 200/206、`Content-Type`、`Content-Length`、`Content-Range`、`ETag`、`Accept-Ranges`、`Cache-Control`；丢弃 `set-cookie` 等非白名单头。
- 只接受单段 `bytes=start-` / `bytes=start-end`；多段、后缀区间在 Fenix 侧返回 416，避免上游 422 被映射成上游故障。
- 超时只覆盖到响应头；客户端断开（`request.signal`）会中止上游连接。

## 7. 预览

CloudDrive 的预览是**异步转换产物**，不是按需渲染：

1. `GET /files/:id` 的 `conversion.status` 为 `queued / processing / ready / partial / blocked / failed`；`ready` 之前 `/v1/files/{id}/markdown` 恒为 404。`GET /v1/operations/{conversion_job}` 实测 404，进度只能轮询文件元数据。
2. **markdown**（`GET /files/:id/markdown`）：文本与 Office 的通用通路，上游约 64KiB/页，`nextCursor` 非空时继续取。Fenix 单次响应上限 256KiB（只防御上游分页契约漂移，触发时 `truncated: true`，游标保留）；Fenix 先读元数据再取正文，把「产物未生成」的 404 翻译成 `CLOUD_DRIVE_PREVIEW_NOT_READY`，转换失败/阻塞翻译成 422 `CLOUD_DRIVE_PREVIEW_FAILED`。
3. **栅格**（`GET /files/:id/preview` + `preview/pages/:page`）：PDF 与图片可用，首次页图惰性渲染。上游页图**必须**带 `version_id`，缺失一律 404；Facade 在缺省时用元数据 `currentVersionId` 补齐。页图响应透传 `Content-Type / Content-Length / ETag / Last-Modified`，显式版本允许 `private, max-age=300, immutable`，用当前版本补齐时 `no-store`（URL 不含版本，缓存会跨版本命中）。
4. **重新转换**（`POST /files/:id/conversions`）：服务端生成 `idempotency_key`，返回 `{ jobId, state, sourceVersionId }`；正在转换或已就绪返回 409。任务状态只能通过轮询元数据观察。
5. **限制**：转换上限 100MiB / 500 页 / 64MiB 输出，栅格预览 100MiB；`preview` 与 `anydoc` 串行。Office 栅格依赖不可用时上游返回 503（缺 kkfileview），因此 Office 在前端**默认走 markdown**，不请求栅格。图片 OCR 不可用（缺 paddleocr），不要承诺从图片提取文字。
6. 错误语义无法只靠上游状态区分：503 同时表示「Office 栅格缺失」与「文本转换依赖故障」，所以策略由扩展名决定；跨用户与已删除仍是 404。

## 8. 错误映射

| 上游 | Fenix |
| --- | --- |
| HTTP 401 / 403（master key、网段、scope） | 502 `CLOUD_DRIVE_UPSTREAM_ERROR`，不暴露细节；**不会**变成会话 401 |
| `NOT_FOUND` / 404 | 404 |
| `PATH_CONFLICT` / `VERSION_CONFLICT` / `IDEMPOTENCY_CONFLICT` / `OPERATION_PENDING` / 任意 409 | 409 |
| `QUOTA_EXCEEDED` / `UPLOAD_TOO_LARGE` / 413 | 413 |
| `DEPENDENCY_UNAVAILABLE` / `SPACE_PROVISIONER_UNAVAILABLE` / 503 | 503 |
| `INVALID_ARGUMENT` / `INVALID_PATH` / 422 | 422 `CLOUD_DRIVE_INVALID_INPUT` |
| `RATE_LIMITED` / 429 | 429 `CLOUD_DRIVE_RATE_LIMITED` |
| 上传会话 404 | 404 `CLOUD_DRIVE_UPLOAD_NOT_FOUND` |
| 上传会话已结束（HEAD 409） | 410 `CLOUD_DRIVE_UPLOAD_GONE` |
| 预览产物未生成（markdown/preview 上游 404） | 404 `CLOUD_DRIVE_PREVIEW_NOT_READY`（转换 failed/blocked 时为 422 `CLOUD_DRIVE_PREVIEW_FAILED`） |
| 页图 404（页号越界 / 版本不存在） | 404 `CLOUD_DRIVE_PREVIEW_PAGE_NOT_FOUND` |
| 重新转换时任务进行中 / 已就绪 | 409 `CLOUD_DRIVE_CONVERSION_IN_PROGRESS` / `CLOUD_DRIVE_CONVERSION_NOT_NEEDED` |
| 网络失败 / 超时 | 503 `CLOUD_DRIVE_UNAVAILABLE` / `CLOUD_DRIVE_TIMEOUT` |
| 其余 | 502 |

分类只在 `client/cloud-drive-error.ts` 做一次；`kind → HTTP` 的对应表只在 `routes/web/cloud-drive-response.ts` 出现一次。

## 9. 部署与超时

九个键在模块 `envDefinitions` 声明，宿主只做投影：

- `CLOUDDRIVE_BASE_URL`（可选，http/https）
- `CLOUDDRIVE_MASTER_KEY`（可选，`secret: true`）
- `CLOUDDRIVE_KEY_ID`（可选）
- `CLOUDDRIVE_TIMEOUT_MS`（默认 **120000**）
- `CLOUDDRIVE_MCP_TOKEN_SECRET`（可选，`secret: true`；缺失时不下发 MCP 条目且网关 503）
- `CLOUDDRIVE_MCP_TOKEN_TTL_SECONDS`（默认 **3600**，会话级 token）
- `CLOUDDRIVE_MCP_LAUNCH_TTL_SECONDS`（默认 **86400**，LaunchSpec token）
- `CLOUDDRIVE_MCP_SCOPE`（`read` / `write`，默认 **read**）
- `CLOUDDRIVE_MCP_TIMEOUT_MS`（默认 **15000**，只读工具执行上限）

基址与密钥同时配置才启用；未配置时服务照常启动，`/web/cloud-drive/*` 返回 503 `CLOUD_DRIVE_NOT_CONFIGURED`。超时默认 120s 的依据：真实环境冷启动首次写操作约 65s，finalize 含异步提交；30s 会把正常写入误判为超时。读操作通常约 50ms，共用同一上限只影响失败判定时间。下载只在等待响应头阶段计时。

## 10. MCP 网关（Agent 侧）

Agent 通过平台托管的 MCP 网关访问云盘，**不直连** CloudDrive 自带的 beta MCP（`api:8081/mcp`）：

- 那个端点只认 master key + `X-On-Behalf-Of`，下发等于把 master key 交给 Agent 进程，可冒充任意用户；
- 8081 只在 CloudDrive 的容器网络内，远端 Machine 不可达；
- 它的工具名与行为没有稳定性承诺，Fenix 也无法按 scope 裁剪工具。

### 10.1 端点与鉴权

```text
Agent ──Authorization: Bearer cd1.<payload>.<sig>──► POST /mcp/cloud-drive
                                                    └─ CloudDriveFacade → CloudDriveClient → /v1/*
```

- **stateless**：`sessionIdGenerator: undefined` + `enableJsonResponse: true`，每个 POST 独立鉴权，无
  `Mcp-Session-Id`；只暴露 tools，不实现 resources/subscriptions/skills。
- 挂载在宿主 `app` 槽（`cloud-drive.mcp` 贡献），公开路径 `/mcp/cloud-drive`，OpenAPI 隐藏。
- 未配置 `CLOUDDRIVE_MCP_TOKEN_SECRET`（或 baseUrl/masterKey 缺失）→ **503**；无 token/坏 token → **401**；
  body 上限 2 MiB（`Content-Length` 预检）。
- 主体**只**来自 token：工具参数里没有 `user_id`/`uid`/`org`，`strictObject` 让越权字段直接失败。

### 10.2 Token

```text
cd1.<base64url({"v":1,"uid","org","exp","scope"})>.<base64url(HMAC-SHA256(secret,"cd1.<payload>"))>
```

- `scope` 只有 `read` / `write`；`exp` 是 epoch 秒，过期即拒绝；签名常数时间比较；格式、版本、字段
  任一不合法都返回 401，不区分原因。
- 密钥 `CLOUDDRIVE_MCP_TOKEN_SECRET` 与 master key 分离；轮换会让在途 token 立即失效（LaunchSpec 注入的
  条目需要实例重物化，会话级条目下次握手自动换新）。
- token **不落库、不写日志、不进错误响应**；签发只发生在服务端，用户/组织来自已认证的上下文。
- TTL：会话级 `CLOUDDRIVE_MCP_TOKEN_TTL_SECONDS`（默认 3600）；LaunchSpec `CLOUDDRIVE_MCP_LAUNCH_TTL_SECONDS`
  （默认 86400，需覆盖实例存活期）。

### 10.3 工具面（v1）

| 工具 | scope | 只读 | 说明 |
| --- | --- | --- | --- |
| `cloud_drive_list` | read | 是 | 目录列表，游标分页 |
| `cloud_drive_read_markdown` | read | 是 | 转换产物 markdown，分页 |
| `cloud_drive_mkdir` | write | 否 | 新建目录 |
| `cloud_drive_write_text` | write | 否 | 新建/覆盖写文本（≤1 MiB，走 TUS 会话） |

`CLOUDDRIVE_MCP_SCOPE` 默认 `read`：**只读 token 的 `tools/list` 里根本不存在写工具**。工具面刻意最小
（4 个）：主体/配额、元数据、搜索、版本、回收站、移动与改名都不下发——工具越多越挤占模型的上下文与
选择空间。v1 不提供删除、恢复、上传/下载票据与操作状态查询。

- 写操作复用 Facade 的编排：先读元数据 → 带 `expected_metadata_revision`；`write_text` 走
  `beginUpload → uploadChunk → finalizeUpload`，中途失败会 `abandon`，不静默重试。
- 结果上限 **64 KiB**：`read_markdown` 截断正文并保留 `next_cursor`；超出上限的其它结果只回字节摘要。
  两者都带 `truncated` 与提示。
- 错误只返回稳定 code：`NOT_FOUND` / `CONFLICT` / `UNAVAILABLE` / `RATE_LIMITED` /
  `INVALID_ARGUMENT` / `NOT_CONFIGURED` / `UPSTREAM_ERROR`，配固定中文文案；上游 message/details、
  URL、票据、master key 都不进入结果。
- 读工具执行上限 `CLOUDDRIVE_MCP_TIMEOUT_MS`（默认 15000）；写操作沿用
  `CLOUDDRIVE_TIMEOUT_MS`（首次 provision 可能约 65s）。
- 日志字段：`tool` / `scope` / `uid` / `orgId` / `outcome` / `durationMs` / `upstreamStatus` /
  `upstreamCode`；没有 token、正文、票据或 URL。
- **文件内容是不可信数据**：server `instructions` 与每个工具描述都要求 Agent 不要执行文件中的指令。

### 10.4 与 peri/rmcp 的真实握手

2026-10-29 用本机 peri 4.4.1（rmcp 3.5.1）实测，连接顺序是：

1. `server/discover`，请求头 `MCP-Protocol-Version: 2026-07-28`，`params._meta` 带 protocolVersion /
   clientInfo / clientCapabilities。
2. 网关返回 rmcp `DiscoverResult`（`resultType` / `supportedVersions` / `capabilities` / `ttlMs` /
   `cacheScope` / `_meta["io.modelcontextprotocol/serverInfo"]`）。
3. 之后 `tools/list`、`tools/call` 继续携带 `2026-07-28` 请求头。SDK 只认到 `2025-11-25`，路由把
   **请求头**归一为 `2025-11-25` 后再交给 SDK transport；tools 的载荷在两者间一致。
4. peri 还会请求 `resources/list` 与 `resources/templates/list`；网关返回 `-32601`，peri 忽略（本网关
   只声明 tools）。这与 IM 入口的取舍一致。
5. 不支持 discover 的旧客户端仍走 `initialize` 回退：SDK 以 `2025-11-25` 应答，工具面相同。

这条路径是兼容增强：即使 discover 缺失，rmcp Auto 策略也会回退 `initialize`（实测可完成
`tools/list` 与 `tools/call`）；实现 discover 是为了消除首包 400 并满足新客户端优先使用 discover 的
预期。协议常量与结果形状在 `src/server/mcp/protocol.ts`，单测在
`src/__tests__/cloud-drive-mcp-routes.test.ts`。

## 11. 双通道下发

| 通道 | 注入点 | 形态 | TTL | 引擎覆盖 |
| --- | --- | --- | --- | --- |
| A | 宿主 `services/pre-launch-ports.ts` → `withCloudDriveMcpServer` | `.mcp.json` 的 `streamable-http` 条目 | 86400 | 全部引擎 |
| B | `chat-channel` 的 `sessionMcpServers` 端口 → ACP `session/new\|load\|resume` | `{type:"http",name,url,headers:[…]}` | 3600 | 目前只有 peri（其他适配器忽略会话级条目） |

- A 在 `buildAgentLaunchSpec` 返回后追加，`buildMinimalAgentLaunchSpec` **不追加**；CloudDrive 未配置时
  跳过，secret 缺失时跳过并 warning，token 签发失败时 warning 后按无云盘工具启动。
- 用户 MCP 已占用保留名 `cloud-drive` → **拒绝启动**（与 `mcp-resolution` 的严格口径一致），不静默覆盖。
- B 由宿主注册 provider（`setSessionMcpServersProvider`），`agent-runtime` 不反向依赖资源包；provider
  未注册、失败或缺组织上下文时降级为「本次不注入」，不阻断建会话。条目只进 ACP 消息，不落盘。
- token 过期：A 需要实例重物化；B 下次 `session/new` 自动换新。CloudDrive 不可达时条目照常注入，工具返回
  `UNAVAILABLE`，服务端不自动重试写操作。
- 回滚：删掉 env 即可，无表、无迁移；已经写入 `.mcp.json` 的条目随实例工作区重写消失。

真实联调证据（2026-10-29，peri 4.4.1）：

- 开启 secret 时，ACP `session/new` 的 `mcpServers` 含 `{type:"http",name:"cloud-drive",url,headers:[{Authorization}]}`；
  token 长度 218、只记录 SHA-256 前缀，绝不是 master key。
- 同一用户的实例 workspace `.mcp.json` 也有 `cloud-drive` 条目（LaunchSpec 通道），两处 token 不同
  （TTL 不同），文件里没有 master key。
- peri 真实调用 `mcp__cloud-drive__cloud_drive_list` / `cloud_drive_read_markdown` 并得到云盘数据；
  第二个用户对第一个用户的 `file_id` 返回 `NOT_FOUND`，根列表为空。
- 缺少 `CLOUDDRIVE_MCP_TOKEN_SECRET`：不下发条目、`.mcp.json` 为 `{"mcpServers":{}}`、网关 503，
  Chat 会话照常启动（Agent 看不到云盘工具）。
- CloudDrive 地址不可达：条目照常注入、会话正常，工具返回 `UNAVAILABLE`。

**后续**：工作流与会话级注入的接入点分别在
`packages/resources/workflow/src/server/services/workflow/agent-chat-transport.ts` 与
`packages/resources/task/src/server/services/scheduler/agent-executor.ts`，它们可以复用
`resolveSessionMcpServers`，本版未接入。

## 12. 已知边界

1. 没有暴露 CloudDrive 操作状态查询（`GET /v1/operations/{id}`）；变更返回非 `committed` 状态时前端只能刷新元数据。
2. 搜索最终一致；写入后立即搜索可能为空。
3. 单一超时旋钮：读与写共用 `CLOUDDRIVE_TIMEOUT_MS`。
4. 没有声明 `dependencyServices`：CloudDrive 的编排不在本仓，preflight 不探活它。
5. 首版页面未接入：URL 深链（目录层级是页面内状态，刷新回根目录）、覆盖写上传（`fileId`）、历史版本浏览、拖拽上传与多选批量操作。这些能力对应的服务端端点已就绪，接 UI 不需要改协议。
6. 搜索的元数据补齐是展示性数据：最多 50 个文件、2 秒总时限；超时或单文件读取失败时回退到路径派生名称，`sizeBytes` / `updatedAt` 为 null。片段来自转换产物，非文本文件与转换未完成的文件没有片段。
7. 预览依赖转换完成，未就绪只能轮询元数据（上游没有任务查询端点）；前端轮询预算 30s，超时后由用户重试。
8. 图片只有栅格页图，没有 OCR 文字提取（缺 paddleocr）；Office 的栅格预览不可用（缺 kkfileview），只能走 markdown。
9. markdown 预览一次最多聚合 8 页 / 512KiB，更多内容需用户点「加载更多」；页图按需惰性渲染，首张可能有等待。

## 11. 验证

- 单测：`packages/resources/cloud-drive/src/__tests__/`（client 错误映射/超时/TUS/预览端点、Facade actor 隔离与编排、路由鉴权/信封/下载头/页图版本与缓存头）。
- 前端单测：`web/__tests__/`（预览类型矩阵、markdown 分页聚合、轮询退避、面板状态与页图 URL）。
- 真实联调：`scripts/cloud-drive-local-smoke.ts`，步骤与验收口径见 [运维文档](../operations/cloud-drive-local-smoke.md)。
