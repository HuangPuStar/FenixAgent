# Workspace 文件系统 API 设计

**日期**：2026-07-01 | **状态**：已确认

## 背景

当前 agent 文件系统仅通过 `GET /web/environments/:id/user-file/tree` 暴露 `user/` 目录的递归文件树。用户需要在右侧面板看到整个 workspace 运行目录的全貌（agent 运行过程中产生的其他目录和文件），并支持对 workspace 内任意位置的文件操作。

## 设计决策

| 决策 | 结论 |
|------|------|
| 过滤策略 | **黑名单模式**：默认显示全部非 user/ workspace 目录，隐藏黑名单中的目录 |
| API 策略 | **新增独立接口**，前缀 `fs/*`，旧 `user`/`user-file` 接口不动 |
| 读写权限 | 同一面板，能看见就能操作，无需额外权限校验 |
| 黑名单配置 | **服务端硬编码全局固定**，无 DB/环境变量配置 |

## 新 API 端点

**路由文件**：`src/routes/web/fs.ts`，前缀 `/environments`，挂载到 `/web/environments`

所有响应遵循 `/web/*` 规范：`{ success: true, data }` / `{ success: false, error }`。

### 端点一览

| 方法 | 路径 | 用途 | 入参 |
|------|------|------|------|
| `GET` | `/:id/fs/tree` | 递归扫描 workspace 树（黑名单过滤） | — |
| `GET` | `/:id/fs` | 按 `?path=` 列单层目录 | query: `path` |
| `GET` | `/:id/fs/*` | 读文件（文本/二进制/预览） | `?preview=true` |
| `POST` | `/:id/fs/*` | 上传文件 | FormData `files` + `relativePaths` |
| `PUT` | `/:id/fs/*` | 写入文本内容 | body: `{ content }` |
| `DELETE` | `/:id/fs/*` | 删除单个文件 | — |
| `POST` | `/:id/fs/mkdir` | 创建目录 | body: `{ path }` |
| `POST` | `/:id/fs/rename` | 重命名/移动 | body: `{ oldPath, newPath }` |
| `DELETE` | `/:id/fs/batch` | 批量删除 | body: `{ paths }` |
| `GET` | `/:id/fs/download-zip` | 打包下载 | `?path=` |

### 黑名单目录

服务端硬编码，`workspace-fs.ts` 中常量化：

```
.git, node_modules, dist, build, target, out, .next, .nuxt,
.venv, venv, __pycache__, .cache, .pytest_cache,
vendor, .terraform, .idea, .vscode, coverage, .nyc_output,
.opencode, .tmp, tmp, .turbo
```

## 底层改动

核心变化集中在 `src/services/workspace-fs.ts`：

1. **新增黑名单常量** `WORKSPACE_BLACKLIST` — 覆盖常见构建产物、依赖、IDE 配置目录
2. **新增 `shouldHideEntry(name, path)` 函数** — 统一过滤逻辑，`listDirectory` 和 `listPathsRecursive` 共用
3. **`listPathsRecursive` 扩展** — 从仅扫 `user/` 扩展为从 `workspaceDir` 根开始扫描，应用黑名单过滤
4. **移除 `isUserPath` 写保护** — 新 `fs` 路由不再校验 `isUserPath`，写操作覆盖全 workspace

### 不变部分

- 旧路由文件 `files.ts` / `user-file.ts` 不修改
- 前端 `fileApi` / `userFileApi` 模块不修改
- 远程环境通过 `remote-file-service` 已有完整文件操作能力，新端点复用

## 实现范围

### 后端（新增）

| 文件 | 内容 |
|------|------|
| `src/routes/web/fs.ts` | 新路由，10 个端点，鉴权 `sessionAuth: true` |
| `src/services/workspace-fs.ts` | 新增黑名单常量、`shouldHideEntry()`、扩展 `listPathsRecursive` |
| `src/schemas/file.schema.ts` | 复用已有 schema，必要时新增少量 schema |
| `src/routes/web/index.ts` | 注册 `webFs` 路由 |
| `src/openapi.ts` | 新增 `FS` tag 描述 |

### 前端（后续可选，不在本轮范围）

- 新增 `web/src/api/fs.ts` — 对偶的 `fsApi` 模块
- 更新 `FileTreeTab.tsx` — 切换到 `fsApi.tree()`
- 更新右键菜单操作 — 切换到 `fsApi` 的 rename/mkdir/batch-delete

## 兼容性

- 旧 API 完整保留，前端可渐进迁移
- 新接口与旧接口在 workspace 层共用底层 `workspace-fs.ts`，仅过滤/作用域不同
- 无需数据库迁移
