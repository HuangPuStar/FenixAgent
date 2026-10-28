# @fenix/resource-cloud-drive

个人云盘能力的唯一 owner：把 CloudDrive REST（`/v1/*`）作为受信任调用方代理给 Fenix 控制台。Fenix 不建表、不缓存状态，文件、目录、版本、回收站、配额全部由 CloudDrive 持有。

## 定位与 owner

- **本包拥有**：`/web/cloud-drive/*` 的 16 条服务端路由、出站 HTTP client（认证头、超时、错误分类）与协议模型（`src/server/schemas/cloud-drive.schema.ts`）。
- **不属本包**：用户认证与组织上下文（宿主 `apps/server` 的会话守卫）、CloudDrive 的空间 provisioner / master key 轮换（CloudDrive 部署）、前端页面（后续 owner 在同一分支补 `web/`）。
- **装配面**：`fenix.module.ts` 的 `id: "cloud-drive"` / `kind: "resource"` / `dependsOn: []` / `capabilities: ["resource.cloud-drive"]`；一条 `slot: "web"` 路由贡献。它是资源装配图里的叶子，不依赖其它资源模块。
- **无状态**：没有 Repository、Domain Service、`create()` 组合根或任何 DB 句柄。写入幂等由 CloudDrive 的 `idempotency_key` 表达，Fenix 侧每次写操作生成新 key。

## 信任边界

```text
浏览器 ──/web/cloud-drive/*（session cookie）──► Fenix 后端
Fenix 后端 ──Authorization: Bearer <master key> + X-On-Behalf-Of: <Fenix userId>──► CloudDrive /v1/*
```

- `X-On-Behalf-Of` 只来自 `store.authContext.userId`（服务端会话派生）。路由参数、请求体、查询串**没有**用户标识字段；client 的 `baseHeaders()` 也不接受调用方覆盖认证头。
- master key 只存在于服务端模块配置；不写入源码、日志、错误响应或前端响应。响应里刻意不含 CloudDrive 的 `upload_url`（前端只能经 `/web/cloud-drive/uploads/:id` 续传）。
- 跨用户隔离由 CloudDrive 按 `(issuer, subject)` 分区保证；Fenix 侧只保证「永远是当前登录用户」。

## HTTP 面（`/web` 槽）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cloud-drive/me` | 主体与配额（上限 / 已用 / 预留） |
| GET | `/cloud-drive/files?parentId=&cursor=` | 目录列表，游标分页 |
| GET | `/cloud-drive/files/:id` | 元数据 |
| GET | `/cloud-drive/files/:id/versions` | 历史版本 |
| GET | `/cloud-drive/files/:id/content` | 流式下载，透传单段 Range 与内容头 |
| POST | `/cloud-drive/directories` | 新建目录 |
| PATCH | `/cloud-drive/files/:id/location` | 改名 / 移动（`parentId: null` = 根目录） |
| DELETE | `/cloud-drive/files/:id` | 移入回收站 |
| GET | `/cloud-drive/trash` | 回收站列表 |
| POST | `/cloud-drive/trash/:id/restore` | 恢复（需带 `expectedMetadataRevision`） |
| POST | `/cloud-drive/search` | 关键词搜索（最终一致） |
| POST | `/cloud-drive/uploads` | 创建 TUS 上传会话（服务端生成 `idempotency_key`） |
| GET | `/cloud-drive/uploads/:id` | 查询 `offset` / `length` |
| PATCH | `/cloud-drive/uploads/:id` | 上传一个分片（原始 body + `Content-Length` + `Upload-Offset`） |
| POST | `/cloud-drive/uploads/:id/finalize` | 提交 |
| POST | `/cloud-drive/uploads/:id/abandon` | 放弃 |

除二进制下载与分片上传外，响应统一 `{ success: true, data }` / `{ success: false, error: { code, message } }`。

## 上传（TUS 代理）

1. `POST /uploads` → `{ uploadId, fileId, operationId, status, expiresAt }`；
2. 对 `/uploads/:id` 发 `PATCH`，`Content-Type: application/offset+octet-stream` 由服务端固定，`Content-Length` 必须存在（CloudDrive 拒绝 chunked），`Upload-Offset` 取自 `GET /uploads/:id`；
3. 响应体返回最新 `{ uploadId, offset, length }`，同时设置 `Upload-Offset` / `Upload-Length` 响应头；
4. 全部写完后 `POST /uploads/:id/finalize`；失败或取消时 `POST /uploads/:id/abandon`。

分片建议 **4 MiB**（`CLOUD_DRIVE_RECOMMENDED_CHUNK_BYTES`）：CloudDrive 单请求上限 64 MiB，宿主全站 body 上限 108 MiB。

覆盖写：`POST /uploads` 带 `fileId`，Facade 先读当前元数据，用 `currentVersionId` + `metadataRevision` 做乐观并发校验；覆盖写不允许改名或移动。

## 错误映射

| 上游 | Fenix |
| --- | --- |
| HTTP 401 / 403（master key、网段、scope） | 502 `CLOUD_DRIVE_UPSTREAM_ERROR`，不暴露上游细节；**绝不**映射成会话失效 |
| `NOT_FOUND` / HTTP 404 | 404 `NOT_FOUND` |
| `PATH_CONFLICT` / `VERSION_CONFLICT` / `IDEMPOTENCY_CONFLICT` / `OPERATION_PENDING` / HTTP 409 | 409（请求未被受理；重试前先刷新元数据或轮询操作） |
| `QUOTA_EXCEEDED` / `UPLOAD_TOO_LARGE` / HTTP 413 | 413 |
| `DEPENDENCY_UNAVAILABLE` / `SPACE_PROVISIONER_UNAVAILABLE` / HTTP 503 | 503 |
| 网络失败 / 超时 | 503 `CLOUD_DRIVE_UNAVAILABLE` / `CLOUD_DRIVE_TIMEOUT` |
| 其余 | 502 |

`OPERATION_PENDING` 取 409 而不是 202：请求没有被受理，202 会误导前端以为操作已经开始。上游未列出 code（如 `INVALID_ARGUMENT` / `INVALID_PATH`）同样按「其余 → 502」处理；若后续需要把用户输入错误区分成 400/422，改 `client/cloud-drive-error.ts` 一处即可。

## 部署配置

四个键都在本包 `fenix.module.ts` 的 `envDefinitions` 声明，宿主 `apps/server/src/env.ts` 不重复声明：

- `CLOUDDRIVE_BASE_URL`：CloudDrive REST 基址（http/https）；未配置 = 未启用，返回 503。
- `CLOUDDRIVE_MASTER_KEY`：master key（`secret: true`）；与基址同时配置才启用。
- `CLOUDDRIVE_KEY_ID`：可选，随请求发送 `X-Key-Id`。
- `CLOUDDRIVE_TIMEOUT_MS`：出站超时，默认 30000；下载只在等待响应头阶段计时。

## 单测

`src/__tests__/` 用注入的 `fetch` 与内存 Gateway 覆盖：认证头与 subject 隔离、上游错误映射、超时、master key 不出现在错误/日志、Facade 的先读后写编排、路由鉴权与错误信封、TUS 的 header/offset 语义。测试不引入 `mock.module()`。
