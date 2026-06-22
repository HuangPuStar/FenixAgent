# 文件

> 对应文件：`src/routes/web/files.ts`

## 这个模块干什么

文件系统为 Agent 的会话提供文件读写能力。用户可以在控制面板中浏览、上传、预览 Agent 工作目录下的文件。

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

## 和其他模块的关系

- ← 前端通过 API client 调用文件接口
- ← Agent 运行时产生的文件在 workspace 目录中
- 会话文件路径需要 SessionRepo 的 ID 转换
