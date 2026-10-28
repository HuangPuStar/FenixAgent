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
| 控制台页面与语言资源 | 前端（后续阶段） |

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

16 条 `/web/cloud-drive/*` 路由（`routes/web/`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me` | 主体与配额（上限 / 已用 / 预留） |
| GET | `/files?parentId=&cursor=` | 目录列表，游标分页 |
| GET | `/files/:id` | 元数据 |
| GET | `/files/:id/versions` | 历史版本 |
| GET | `/files/:id/content` | 流式下载，单段 Range，带文件名 |
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

除二进制下载与分片上传外，响应统一 `{ success: true, data }` / `{ success: false, error: { code, message } }`。DTO 在上游边界重写为 camelCase，并丢弃 `owner_id` / `space_id` / `native_*` / `reserved_location` / `operation_id` 等内部字段。

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

## 7. 错误映射

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
| 网络失败 / 超时 | 503 `CLOUD_DRIVE_UNAVAILABLE` / `CLOUD_DRIVE_TIMEOUT` |
| 其余 | 502 |

分类只在 `client/cloud-drive-error.ts` 做一次；`kind → HTTP` 的对应表只在 `routes/web/cloud-drive-response.ts` 出现一次。

## 8. 部署与超时

四个键在模块 `envDefinitions` 声明，宿主只做投影：

- `CLOUDDRIVE_BASE_URL`（可选，http/https）
- `CLOUDDRIVE_MASTER_KEY`（可选，`secret: true`）
- `CLOUDDRIVE_KEY_ID`（可选）
- `CLOUDDRIVE_TIMEOUT_MS`（默认 **120000**）

基址与密钥同时配置才启用；未配置时服务照常启动，`/web/cloud-drive/*` 返回 503 `CLOUD_DRIVE_NOT_CONFIGURED`。超时默认 120s 的依据：真实环境冷启动首次写操作约 65s，finalize 含异步提交；30s 会把正常写入误判为超时。读操作通常约 50ms，共用同一上限只影响失败判定时间。下载只在等待响应头阶段计时。

## 9. 已知边界

1. 没有暴露 CloudDrive 操作状态查询（`GET /v1/operations/{id}`）；变更返回非 `committed` 状态时前端只能刷新元数据。
2. 搜索最终一致；写入后立即搜索可能为空。
3. 单一超时旋钮：读与写共用 `CLOUDDRIVE_TIMEOUT_MS`。
4. 没有声明 `dependencyServices`：CloudDrive 的编排不在本仓，preflight 不探活它。
5. 未实现前端页面 / web contribution；`ce.json` 的 `web` 列表暂不包含本模块。

## 10. 验证

- 单测：`packages/resources/cloud-drive/src/__tests__/`（client 错误映射/超时/TUS、Facade actor 隔离与编排、路由鉴权/信封/下载头）。
- 真实联调：`scripts/cloud-drive-local-smoke.ts`，步骤与验收口径见 [运维文档](../operations/cloud-drive-local-smoke.md)。
