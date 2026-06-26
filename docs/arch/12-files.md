# 文件系统

> 对应文件：`src/routes/web/files.ts`、`src/routes/web/user-file.ts`、`src/services/workspace-fs.ts`、`src/services/workspace-resolver.ts`、`src/transport/file-ws-handler.ts`、`src/services/remote-file-service.ts`

## 这个模块干什么

文件系统为 Agent 环境（Environment）提供文件读写能力。用户可以在控制面板中浏览、上传、预览、编辑 Agent 工作目录下的文件。支持本地环境（直接文件系统操作）和远程环境（通过 File WS 代理到远程机器）。

## 环境工作空间

### 路径公式

每个 environment 有一个隔离的 workspace 目录，路径由 `src/services/workspace-resolver.ts` 计算：

```text
{WORKSPACE_ROOT ?? cwd/workspaces}/{organizationId}/{userId}/{environmentId}
```

环境变量 `WORKSPACE_ROOT` 可自定义根目录（如未设置，默认 `./workspaces`）。

DB 的 `environment.workspace_path` 列已废弃，所有模块统一通过 `resolveWorkspacePath()` 实时计算。

### 目录结构

```text
{workspaceDir}/
  user/            ← 用户上传区（唯一可见作用域）
  .opencode/       ← Agent 运行时配置（自动隐藏）
  .scheduled-runs/ ← agent-task-runner 执行目录
```

文件 API 仅允许操作 `user/` 子目录下的内容（本地环境）。远程环境的操作范围由远程节点自行控制。

## 两大路由模块

文件功能由两个 Elysia 路由模块提供，都挂载在 `/web/environments` 前缀下：

### 1. web-files（`src/routes/web/files.ts`）——基础文件 CRUD

| 方法 | URL | 说明 |
|------|-----|------|
| GET | `/web/environments/:id/user` | 列出目录内容，参数 `?path=user/subdir` |
| GET | `/web/environments/:id/user/*` | 读取文件内容（文本返回 JSON，二进制返回流） |
| POST | `/web/environments/:id/user/*` | 上传文件（multipart，支持文件夹上传） |
| PUT | `/web/environments/:id/user/*` | 写入文件内容（`{ content: "..." }`） |
| DELETE | `/web/environments/:id/user/*` | 删除单个文件（不支持删除目录） |

所有端点需要 `sessionAuth`。读取端点中 `?preview=true` 会切换 Content-Type 为浏览器可预览的 MIME，并放宽 CSP 策略。

### 2. web-user-file（`src/routes/web/user-file.ts`）——高级文件操作

| 方法 | URL | 说明 |
|------|-----|------|
| GET | `/web/environments/:id/user-file/tree` | 递归列出 user/ 下所有路径及修改时间 |
| POST | `/web/environments/:id/user-file/rename` | 重命名/移动文件或目录（`{ oldPath, newPath }`） |
| POST | `/web/environments/:id/user-file/mkdir` | 创建目录（`{ path }`） |
| DELETE | `/web/environments/:id/user-file/batch` | 批量删除文件（`{ paths: [...] }`），返回成功/失败列表 |
| GET | `/web/environments/:id/user-file/download-zip` | 打包下载目录为 zip（仅本地环境，使用系统 `zip` 命令流式输出） |

## 远程环境文件操作

当 environment 绑定了远程 machine 时（通过 `getRemoteMachineId(envId)` 判断），文件操作不再访问本地文件系统，而是通过 **File WS** 代理到远程机器：

```text
GET /web/environments/:id/user/...
    │
    ▼
getRemoteMachineId(envId)
    │
    ├── 无 machineId → 本地文件系统操作（resolveWorkspacePath → fs/read/write）
    └── 有 machineId → remoteListDir / remoteReadFile / remoteUploadFiles / ...
        │
        ▼
    sendFileOpAndWait(machineId, operation, params, timeout)
        │
        ▼
    File WS → 远程节点执行 → file_op_result 返回
```

### File WS 架构（`src/transport/file-ws-handler.ts`）

远程机器通过 WebSocket 连接到服务端，发送 `register` 消息（携带 `machine_id`）完成注册。后续服务端通过 `sendFileOpAndWait()` 发送 `file_op` 请求，等待远程节点返回 `file_op_result`。

关键特性：
- `machineId → FileWsConnectionEntry` 索引，支持按机器快速查找连接
- 请求-响应模式，支持超时（默认 60s）
- 新连接注册时自动关闭同 machine 的旧连接
- 断连时自动 reject 所有 pending 请求
- 优雅关闭时关闭所有连接

### 远程文件服务（`src/services/remote-file-service.ts`）

封装了 `remoteListDir`、`remoteReadFile`、`remoteReadBinaryFile`、`remoteUploadFiles`、`remoteWriteFile`、`remoteDeleteFile`、`remoteRename`、`remoteMkdir`、`remoteTree` 等操作，底层均通过 `sendFileOpAndWait()` 完成。

## 文件系统工具（`src/services/workspace-fs.ts`）

提供本地文件系统操作的纯函数工具集：

| 函数 | 说明 |
|------|------|
| `resolveWorkspacePath(envId, relPath)` | 将环境 ID + 相对路径解析为绝对文件系统路径，返回 null 表示路径越界 |
| `isUserPath(path)` | 判断路径是否属于 user/ 作用域 |
| `normalizeUserRoutePath(path)` | 将路由通配符路径规范化为 user/ 前缀 |
| `listDirectory(dirPath, userDir, workspaceDir)` | 列出目录内容，过滤隐藏条目 |
| `readFileContent(filePath)` | 读取文本文件（UTF-8） |
| `writeFileContent(filePath, content)` | 写入文本文件，自动创建父目录 |
| `deleteFile(filePath)` | 删除单个文件 |
| `createFileStream(filePath)` | 创建读取流（用于二进制文件下载） |
| `listPathsRecursive(workspaceDir)` | 递归列出 user/ 下所有路径及修改时间 |
| `renamePath(oldPath, newPath)` | 重命名/移动 |
| `mkdirp(dirPath)` | 递归创建目录 |
| `isTextFile(filePath)` | 检测文件是否为文本（前 8KB 无 NULL 字节） |

## 关键限制

- **文件大小限制**：上传和写入均限制 100MB，超过返回 413
- **100MB 请求体限制**：在 `src/index.ts` 级别通过 `Content-Length` 拦截（全局生效）
- **本地环境仅允许 user/ 路径**：所有写/删操作强制 `isUserPath()` 校验
- **文件夹上传**：通过 `relativePaths` JSON 数组保留目录结构，每个文件允许独立相对路径
- **文本判断**：已知文本扩展名白名单（`.txt .md .json .ts .js ...`），未知扩展名通过前 8KB 检测 NULL 字节
- **中文文件名**：下载时用 RFC 5987 编码（`filename*=UTF-8''...`）

## iframe 预览

前端通过 iframe 嵌入预览文件。URL 格式：

```text
/ctrl/{sessionId}/user/{path}
    ↓ 重写（src/plugins/static.ts 中的重定向规则）
/web/sessions/{sessionId}/user/{path}?preview=true
```

注意：此重定向仍使用旧的 session 前缀路由，是历史遗留路径，实际文件操作已迁移到 environment 路径。

## 和其他模块的关系

- → `src/services/workspace-resolver.ts`：计算 workspace 根路径
- → `src/services/workspace-fs.ts`：本地文件系统工具函数
- → `src/services/remote-file-service.ts`：远程文件操作封装
- → `src/transport/file-ws-handler.ts`：远程文件 WS 连接管理
- → `src/repositories/environment.ts`：查询 environment 记录
- ← 前端通过 API client 调用文件接口
- ← `src/index.ts`：启动时注册 File WS 处理，关闭时 `closeAllFileWsConnections()`
