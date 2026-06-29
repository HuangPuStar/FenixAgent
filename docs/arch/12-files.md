# 文件系统

## 这个模块干什么

文件系统为 Agent 环境（Environment）提供文件读写能力。用户可以在控制面板中浏览、上传、预览、编辑 Agent 工作目录下的文件。支持本地环境（直接文件系统操作）和远程环境（通过 File WS 代理到远程机器）。

## 环境工作空间

### 路径公式

每个 environment 有一个隔离的 workspace 目录，路径由 workspace 路径解析器实时计算：

```text
{workspace 根目录}/{organizationId}/{userId}/{environmentId}
```

workspace 根目录可通过配置自定义（如未设置则使用默认值）。**DB 的 workspace_path 列已废弃**，所有模块统一通过路径解析函数实时计算——确保路径在任何环境下都可重现，不依赖历史数据。

### 目录结构

```text
{workspaceDir}/
  user/            ← 用户上传区（唯一可见作用域）
  .opencode/       ← Agent 运行时配置（自动隐藏）
  .scheduled-runs/ ← Agent 执行器执行目录
```

文件 API 仅允许操作 `user/` 子目录下的内容（本地环境）。远程环境的操作范围由远程节点自行控制。

## 两大路由模块

文件功能由两个路由模块提供，都挂载在 `/web/environments` 前缀下：

### 1. 基础文件 CRUD

| 方法 | URL | 说明 |
|------|-----|------|
| GET | `/web/environments/:id/user` | 列出目录内容，参数 `?path=user/subdir` |
| GET | `/web/environments/:id/user/*` | 读取文件内容（文本返回 JSON，二进制返回流） |
| POST | `/web/environments/:id/user/*` | 上传文件（multipart，支持文件夹上传） |
| PUT | `/web/environments/:id/user/*` | 写入文件内容 |
| DELETE | `/web/environments/:id/user/*` | 删除单个文件（不支持删除目录） |

所有端点需要 session 认证。读取端点中 `?preview=true` 会切换 Content-Type 为浏览器可预览的 MIME 类型。

### 2. 高级文件操作

| 方法 | URL | 说明 |
|------|-----|------|
| GET | `/web/environments/:id/user-file/tree` | 递归列出 user/ 下所有路径及修改时间 |
| POST | `/web/environments/:id/user-file/rename` | 重命名/移动文件或目录 |
| POST | `/web/environments/:id/user-file/mkdir` | 创建目录 |
| DELETE | `/web/environments/:id/user-file/batch` | 批量删除文件，返回成功/失败列表 |
| GET | `/web/environments/:id/user-file/download-zip` | 打包下载目录为 zip（仅本地环境，流式输出） |

## 远程环境文件操作

当 environment 绑定了远程 machine 时，文件操作不再访问本地文件系统，而是通过 **File WS** 代理到远程机器：

```text
文件请求 → 判断环境是否绑定了远程 machine
    │
    ├── 无绑定 → 本地文件系统操作
    └── 有绑定 → 通过 File WS 连接发送文件操作请求到远程节点
```

### File WS 架构

远程机器通过 WebSocket 连接到服务端，发送注册消息（携带机器标识）完成注册。后续服务端通过请求-响应模式发送文件操作请求，等待远程节点返回结果。

关键特性：
- 按机器标识索引连接，支持快速查找
- 请求-响应模式，支持超时（默认 60s）
- 新连接注册时自动关闭同机器的旧连接
- 断连时自动 reject 所有 pending 请求
- 优雅关闭时关闭所有连接

### 远程文件服务

封装了本地文件系统的对等操作（列出目录、读取文件、上传文件、写入文件、删除文件、重命名、创建目录、目录树），底层均通过 File WS 请求-响应模式完成。

## 关键限制

- **文件大小限制**：上传和写入均限制 100MB，超过返回 413
- **100MB 请求体限制**：在服务器入口级别通过 `Content-Length` 拦截（全局生效）
- **本地环境仅允许 user/ 路径**：所有写/删操作强制校验路径合法性
- **文件夹上传**：通过相对路径数组保留目录结构，每个文件允许独立路径
- **文本判断**：已知文本扩展名白名单（`.txt .md .json .ts .js ...`），未知扩展名通过前 8KB 检测 NULL 字节
- **中文文件名**：下载时用 RFC 5987 编码

## iframe 预览

前端通过 iframe 嵌入预览文件。URL 经过重写路由——将旧的 session 前缀路径重定向到新的 environment 路径，附加 `?preview=true` 参数。此重定向是历史路径兼容，实际文件操作已迁移到 environment 维度。

## 和其他模块的关系

- → **Workspace 路径解析器**：计算 workspace 根路径
- → **本地文件系统工具**：文件和目录操作的纯函数工具集
- → **远程文件服务**：远程文件操作封装
- → **File WS 处理器**：远程文件 WS 连接管理
- → **Environment 仓储**：查询 environment 记录
- ← 前端通过 API client 调用文件接口
- ← **服务器入口**：启动时注册 File WS 处理，关闭时清理所有连接
