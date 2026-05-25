# 文件与 S3

> 对应文件：`src/routes/web/files.ts`、`src/routes/web/s3-files.ts`

## 这个模块干什么

文件系统为 Agent 的会话提供文件读写能力。用户可以在控制面板中浏览、上传、预览 Agent 工作目录下的文件。S3 集成提供对象存储能力，用于大文件和长期存储。

## 会话文件系统

### 工作空间结构

每个会话有一个 workspace 目录：

```text
{数据目录}/sessions/{sessionId}/user/    ← 用户上传区
{数据目录}/sessions/{sessionId}/output/   ← Agent 输出区
```

### API 端点

| 方法 | URL | 说明 |
|------|-----|------|
| GET | `/web/sessions/:id/user/*` | 列出目录或下载文件 |
| POST | `/web/sessions/:id/user/*` | 上传文件（multipart） |
| DELETE | `/web/sessions/:id/user/*` | 删除文件 |
| GET | `/web/sessions/:id/user/*?preview=true` | iframe 预览 |

### iframe 预览

前端通过 iframe 嵌入预览文件。URL 格式：

```text
/ctrl/{sessionId}/user/{path}?preview=true
    ↓ 重写为
/web/sessions/{sessionId}/user/{path}?preview=true
```

`index.ts` 中注册了 `/ctrl/:sessionId/user/*` 到 `/web/sessions/:id/user/*` 的重定向规则。

### 关键设计

- 文件上传始终写到 `user/` 子目录，不管当前浏览哪个目录
- 文件 API 需要用 **RCS session ID**（不是 ACP 的 `ses_xxx`），需要通过 `resolveExistingSessionId` 做格式转换
- 当 session 找不到时直接返回 404，不做 fallback（不能 fallback 到用户第一个 environment，那几乎总是 `/tmp`）

## S3 对象存储

### 配置

通过环境变量启用和配置：

```text
RCS_S3_ENABLED=true
RCS_S3_ENDPOINT=http://localhost:9000     # S3 兼容服务地址
RCS_S3_REGION=us-east-1
RCS_S3_ACCESS_KEY=xxx
RCS_S3_SECRET_KEY=xxx
RCS_S3_BUCKET_SESSIONS=rcs-sessions       # 会话文件 bucket
RCS_S3_BUCKET_ASSETS=rcs-assets           # 静态资源 bucket
```

### API 端点

| 方法 | URL | 说明 |
|------|-----|------|
| POST | `/web/s3/presign-upload` | 生成上传用的 presigned URL |
| GET | `/web/s3/presign-download` | 生成下载用的 presigned URL |
| DELETE | `/web/s3/object` | 删除 S3 对象 |

### 工作方式

S3 文件操作使用 presigned URL 模式：
1. 前端请求 presigned URL
2. 前端直接上传/下载到 S3（不经过 RCS 服务器）
3. RCS 只负责生成 URL 和管理元数据

两个 bucket：
- `rcs-sessions`：会话相关文件
- `rcs-assets`：其他静态资源

## 和其他模块的关系

- ← 前端通过 API client 调用文件接口
- ← Agent 运行时产生的文件在 workspace 目录中
- 会话文件路径需要 SessionRepo 的 ID 转换
- S3 功能依赖环境变量配置，未启用时相关路由返回错误
