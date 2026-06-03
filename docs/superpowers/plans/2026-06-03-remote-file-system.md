# Remote File System 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让前端文件浏览器能正确显示和操作远程 machine 上的文件，实现本地/远程透明切换。

**Architecture:** 远程 machine 只能主动外连（单向拉取），无法被 RCS 反向连接。在现有 ACP WS（`/acp/ws`，用于 session 管理）之外，新增第二条 WS 连接（`/acp/file-ws`），专门用于文件操作请求-响应。RCS 文件路由层根据 environment 是否绑定远程 machine 来分发：本地走 `workspace-fs.ts`（不变），远程通过 `file-ws` 转发。

**Tech Stack:** WebSocket（NDJSON）、Node.js `fs` API、acp-link client mode、Elysia WS

---

## File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/transport/file-ws-handler.ts` | RCS 端 `/acp/file-ws` 连接管理：注册、消息路由、连接生命周期 |
| `src/services/remote-file-service.ts` | 远程文件操作客户端：构造 `file_op` 消息、通过 file-ws sendAndWait |
| `packages/acp-link/src/client/file-operations.ts` | acp-link 侧文件操作处理器：接收 `file_op` 消息、执行本地 FS 操作、返回 `file_op_result` |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/types/store.ts` | 新增 `FileWsConnectionEntry` 类型 |
| `src/routes/acp/index.ts` | 新增 `/acp/file-ws` WS 端点 |
| `src/routes/web/files.ts` | 每个路由加远程环境判断分支 |
| `src/routes/web/user-file.ts` | 同上 |
| `packages/acp-link/src/server.ts` | `createAcpClient` 中建立第二条 WS 连接到 `/acp/file-ws` |

### 不修改的文件

| 文件 | 原因 |
|------|------|
| `src/services/workspace-fs.ts` | 本地文件操作逻辑完全不变 |
| `src/schemas/file.schema.ts` | API 契约不变，前后端零改动 |
| 前端代码 | API 响应格式不变，前端无需改动 |

---

## WS 协议定义

### `/acp/file-ws` 消息格式

```
acp-link → RCS (注册):
  { "type": "register", "machine_id": "mach_xxx" }

RCS → acp-link (确认):
  { "type": "registered" }

RCS → acp-link (文件操作请求):
  {
    "type": "file_op",
    "request_id": "file_req_xxx",
    "operation": "list|read|read_binary|write|upload|delete|rename|mkdir|tree|stat",
    "params": { ... }
  }

acp-link → RCS (文件操作响应):
  {
    "type": "file_op_result",
    "request_id": "file_req_xxx",
    "status": "ok|error",
    "data": { ... },
    "error": "error message"
  }

双向 (心跳):
  { "type": "keep_alive" }
```

### 操作定义

| operation | params | response.data (ok) |
|-----------|--------|--------------------|
| `list` | `{ path, environmentId }` | `{ entries: FileEntry[] }` |
| `stat` | `{ path, environmentId }` | `{ size, isDirectory, modifiedAt }` |
| `read` | `{ path, environmentId }` | `{ name, path, content, size, encoding: "utf-8" }` |
| `read_binary` | `{ path, environmentId }` | `{ name, path, data(base64), size, mimeType }` |
| `write` | `{ path, content, environmentId }` | `{ name, path, size }` |
| `upload` | `{ dir, files: [{name, content(base64), relativePath}], environmentId }` | `{ files: [{name, path, size}] }` |
| `delete` | `{ path, environmentId }` | `{ ok: true }` |
| `rename` | `{ oldPath, newPath, environmentId }` | `{ oldPath, newPath }` |
| `mkdir` | `{ path, environmentId }` | `{ path }` |
| `tree` | `{ environmentId }` | `{ paths: string[] }` |

### workspace 路径计算（acp-link 侧）

acp-link 使用与 RCS 相同的公式：
```
{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}
```

文件操作请求中携带 `environmentId`，acp-link 从 `InstanceManager.resolveWorkspace()` 复用路径计算逻辑。

---

## Task 1: RCS 端 — `FileWsConnectionEntry` 类型定义

**Files:**
- Modify: `src/types/store.ts`

- [ ] **Step 1: 在 `src/types/store.ts` 末尾添加 `FileWsConnectionEntry` 类型**

在文件末尾添加：

```typescript
// ────────────────────────────────────────────
// File WS Connection
// 用于 /acp/file-ws 端点的远程文件操作连接
// ────────────────────────────────────────────

/** Per-connection state for file operation WebSocket connections (`/acp/file-ws`) */
export interface FileWsConnectionEntry {
  /** 关联的 machine ID（注册后赋值） */
  machineId: string | null;
  /** WS 连接 */
  ws: WsConnection;
  /** 连接 ID */
  wsId: string;
  /** 连接打开时间 */
  openTime: number;
  /** 最后活跃时间（用于超时检测） */
  lastClientActivity: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/store.ts
git commit -m "feat(file-ws): add FileWsConnectionEntry type"
```

---

## Task 2: RCS 端 — `/acp/file-ws` WS handler

**Files:**
- Create: `src/transport/file-ws-handler.ts`

这是文件操作 WS 连接的核心处理器。它管理 machine 连接注册、维护 `machineId → ws` 映射、处理请求-响应路由。

- [ ] **Step 1: 创建 `src/transport/file-ws-handler.ts`**

```typescript
import { log, error as logError } from "@fenix/logger";
import type { FileWsConnectionEntry } from "../types/store";
import type { WsConnection } from "./ws-types";

const connections = new Map<string, FileWsConnectionEntry>();

/** machineId → FileWsConnectionEntry 的快速查找索引 */
const machineFileWsIndex = new Map<string, FileWsConnectionEntry>();

const KEEPALIVE_INTERVAL_MS = 30_000;
const CLIENT_TIMEOUT_MS = KEEPALIVE_INTERVAL_MS * 3;

/** 发送 NDJSON 消息到 WS */
function sendToWs(ws: WsConnection, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(`${JSON.stringify(msg)}\n`);
  } catch (err) {
    logError("[file-ws] send error:", err);
  }
}

/** WS 打开 — 初始化连接追踪 */
export function handleFileWsOpen(ws: WsConnection, wsId: string): void {
  log(`[file-ws] Connection opened: wsId=${wsId}`);

  const entry: FileWsConnectionEntry = {
    machineId: null,
    ws,
    wsId,
    openTime: Date.now(),
    lastClientActivity: Date.now(),
  };
  connections.set(wsId, entry);
}

/** 处理 register 消息 — 绑定 machineId */
export function handleFileWsRegister(wsId: string, msg: Record<string, unknown>): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  const machineId = msg.machine_id as string;
  if (!machineId) {
    sendToWs(entry.ws, { type: "error", message: "machine_id required" });
    return;
  }

  // 如果已有旧连接，关闭旧连接
  const existing = machineFileWsIndex.get(machineId);
  if (existing && existing.wsId !== wsId) {
    log(`[file-ws] Replacing existing connection for machine ${machineId}: old=${existing.wsId} new=${wsId}`);
    try {
      existing.ws.close(1000, "replaced by new connection");
    } catch {
      // ignore
    }
    connections.delete(existing.wsId);
  }

  entry.machineId = machineId;
  machineFileWsIndex.set(machineId, entry);

  log(`[file-ws] Machine registered: machineId=${machineId} wsId=${wsId}`);
  sendToWs(entry.ws, { type: "registered" });
}

/** 处理 file_op_result 消息 — 路由到 pending request */
export function handleFileWsMessage(
  _ws: WsConnection,
  wsId: string,
  data: string | Record<string, unknown>,
): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  entry.lastClientActivity = Date.now();

  const messages: Record<string, unknown>[] = [];
  if (typeof data === "string") {
    for (const line of data.split("\n").filter((l) => l.trim())) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        logError("[file-ws] parse error:", line);
      }
    }
  } else {
    messages.push(data);
  }

  for (const msg of messages) {
    if (msg.type === "keep_alive") continue;

    if (msg.type === "register") {
      handleFileWsRegister(wsId, msg);
      continue;
    }

    if (msg.type === "file_op_result") {
      // 路由到 remote-file-service 的 pending request
      const resolver = fileOpPendingRequests.get(msg.request_id as string);
      if (resolver) {
        fileOpPendingRequests.delete(msg.request_id as string);
        clearTimeout(resolver.timer);
        resolver.resolve(msg);
      } else {
        log(`[file-ws] Orphan file_op_result: request_id=${msg.request_id}`);
      }
      continue;
    }

    log(`[file-ws] Unknown message type: ${msg.type}`);
  }
}

/** WS 关闭 — 清理连接 */
export function handleFileWsClose(_ws: WsConnection, wsId: string): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  log(`[file-ws] Connection closed: wsId=${wsId} machineId=${entry.machineId} duration=${duration}s`);

  if (entry.machineId) {
    machineFileWsIndex.delete(entry.machineId);
  }
  connections.delete(wsId);

  // 拒绝所有该连接上的 pending requests
  for (const [requestId, resolver] of fileOpPendingRequests) {
    if (resolver.wsId === wsId) {
      fileOpPendingRequests.delete(requestId);
      clearTimeout(resolver.timer);
      resolver.reject(new Error("file-ws connection closed"));
    }
  }
}

// ── Remote File Service 集成 ──────────────────────────────────

interface PendingFileOp {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  wsId: string;
}

/** request_id → pending resolver，由 remote-file-service 填充 */
const fileOpPendingRequests = new Map<string, PendingFileOp>();

/** 向远程 machine 的 file-ws 发送 file_op 请求并等待响应 */
export async function sendFileOpAndWait(
  machineId: string,
  operation: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const entry = machineFileWsIndex.get(machineId);
  if (!entry || entry.ws.readyState !== 1) {
    throw new Error(`File WS not connected for machine ${machineId}`);
  }

  const requestId = `file_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fileOpPendingRequests.delete(requestId);
      reject(new Error(`File operation timed out: ${operation} request_id=${requestId}`));
    }, timeoutMs);

    fileOpPendingRequests.set(requestId, {
      resolve: (msg) => resolve(msg),
      reject,
      timer,
      wsId: entry.wsId,
    });

    sendToWs(entry.ws, {
      type: "file_op",
      request_id: requestId,
      operation,
      params,
    });

    log(`[file-ws] → file_op: ${operation} request_id=${requestId}`);
  });
}

/** 检查指定 machine 是否有活跃的 file-ws 连接 */
export function isFileWsConnected(machineId: string): boolean {
  const entry = machineFileWsIndex.get(machineId);
  return !!entry && entry.ws.readyState === 1;
}

/** 优雅关闭所有 file-ws 连接 */
export function closeAllFileWsConnections(): void {
  if (connections.size === 0) return;

  log(`[file-ws] Gracefully closing ${connections.size} connection(s)...`);
  for (const [, entry] of connections) {
    try {
      if (entry.ws.readyState === 1) {
        entry.ws.close(1001, "server_shutdown");
      }
    } catch {
      // ignore
    }
  }
  connections.clear();
  machineFileWsIndex.clear();

  // 拒绝所有 pending requests
  for (const [, resolver] of fileOpPendingRequests) {
    clearTimeout(resolver.timer);
    resolver.reject(new Error("server shutdown"));
  }
  fileOpPendingRequests.clear();

  log("[file-ws] All connections closed");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/transport/file-ws-handler.ts
git commit -m "feat(file-ws): add file-ws handler with request-response routing"
```

---

## Task 3: RCS 端 — `/acp/file-ws` WS 端点注册

**Files:**
- Modify: `src/routes/acp/index.ts`

在现有 `/acp/ws` 和 `/acp/relay/:agentId` 之外，添加 `/acp/file-ws` 端点。认证方式与 `/acp/ws` 相同（`REGISTRY_SECRET`）。

- [ ] **Step 1: 在 `src/routes/acp/index.ts` 中添加 import 和 WS 端点**

在文件顶部的 import 区添加：

```typescript
import {
  handleFileWsClose,
  handleFileWsMessage,
  handleFileWsOpen,
} from "../../transport/file-ws-handler";
```

在 `app` 链的 `"/ws"` 定义之后、`"/relay/:agentId"` 之前，添加 `/file-ws` 端点：

```typescript
  /** WS /acp/file-ws — WebSocket endpoint for remote file operations */
  .ws("/file-ws", {
    async open(ws) {
      const url = new URL(ws.data.request.url);
      const secret = url.searchParams.get("secret");
      const registrySecret = validateEnv().REGISTRY_SECRET;

      if (!secret || !registrySecret || secret !== registrySecret) {
        log("[File-WS] Upgrade rejected: invalid or missing registry secret");
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const wsId = `file_ws_${uuid().replace(/-/g, "")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension
      (ws.data as any).__fileWsId = wsId;
      log(`[File-WS] Upgrade accepted: wsId=${wsId}`);
      handleFileWsOpen(adaptWs(ws), wsId);
    },
    message(ws, data) {
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        logError(`[File-WS] Message too large: ${data.length} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__fileWsId as string | undefined;
      if (wsId) {
        handleFileWsMessage(adaptWs(ws), wsId, data as string | Record<string, unknown>);
      }
    },
    close(ws, code, reason) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__fileWsId as string | undefined;
      if (wsId) {
        handleFileWsClose(adaptWs(ws), wsId, code, reason);
      }
    },
  })
```

- [ ] **Step 2: 在 `src/index.ts` 的优雅关闭流程中添加 file-ws 清理**

找到优雅关闭相关的代码区域，在 `closeAllAcpConnections()` 调用附近添加：

```typescript
import { closeAllFileWsConnections } from "./transport/file-ws-handler";
```

在关闭流程中添加调用：

```typescript
closeAllFileWsConnections();
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/acp/index.ts src/index.ts
git commit -m "feat(file-ws): register /acp/file-ws endpoint and graceful shutdown"
```

---

## Task 4: RCS 端 — `remote-file-service.ts`

**Files:**
- Create: `src/services/remote-file-service.ts`

此服务封装远程文件操作，提供与 `workspace-fs.ts` 类似语义的函数。路由层调用此服务来操作远程文件。

- [ ] **Step 1: 创建 `src/services/remote-file-service.ts`**

```typescript
import { sendFileOpAndWait, isFileWsConnected } from "../transport/file-ws-handler";
import { environmentRepo } from "../repositories";
import { getAgentConfigById } from "./config/agent-config";

/**
 * 判断 environment 是否绑定了远程 machine。
 * 返回 machineId 或 null。
 */
export async function getRemoteMachineId(envId: string): Promise<string | null> {
  const env = await environmentRepo.getById(envId);
  if (!env?.agentConfigId) return null;
  const agentCfg = await getAgentConfigById(env.agentConfigId);
  return agentCfg?.machineId ?? null;
}

/**
 * 检查远程 machine 的 file-ws 是否可用。
 * 如果不可用，抛出带有明确提示的 Error。
 */
function assertFileWsAvailable(machineId: string): void {
  if (!isFileWsConnected(machineId)) {
    throw new Error(`远程机器文件服务不可用 (machine: ${machineId})，请检查远程机器是否在线`);
  }
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: number;
}

/** 列出远程目录内容 */
export async function remoteListDir(
  machineId: string,
  envId: string,
  queryPath: string,
): Promise<RemoteFileEntry[]> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "list", { path: queryPath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return (result.data as { entries: RemoteFileEntry[] }).entries;
}

/** 获取远程文件 stat 信息 */
export async function remoteStat(
  machineId: string,
  envId: string,
  filePath: string,
): Promise<{ size: number; isDirectory: boolean; modifiedAt: number }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "stat", { path: filePath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { size: number; isDirectory: boolean; modifiedAt: number };
}

/** 读取远程文本文件 */
export async function remoteReadFile(
  machineId: string,
  envId: string,
  filePath: string,
): Promise<{ name: string; path: string; content: string; size: number; encoding: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "read", { path: filePath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { name: string; path: string; content: string; size: number; encoding: string };
}

/** 读取远程二进制文件（base64） */
export async function remoteReadBinaryFile(
  machineId: string,
  envId: string,
  filePath: string,
): Promise<{ name: string; path: string; data: string; size: number; mimeType: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "read_binary", { path: filePath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { name: string; path: string; data: string; size: number; mimeType: string };
}

/** 写入远程文本文件 */
export async function remoteWriteFile(
  machineId: string,
  envId: string,
  filePath: string,
  content: string,
): Promise<{ name: string; path: string; size: number }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "write", {
    path: filePath,
    content,
    environmentId: envId,
  });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { name: string; path: string; size: number };
}

/** 上传文件到远程机器（base64 编码） */
export async function remoteUploadFiles(
  machineId: string,
  envId: string,
  dir: string,
  files: Array<{ name: string; content: string; relativePath: string }>,
): Promise<{ files: Array<{ name: string; path: string; size: number }> }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "upload", {
    dir,
    files,
    environmentId: envId,
  }, 120_000); // 上传给更长的超时
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { files: Array<{ name: string; path: string; size: number }> };
}

/** 删除远程文件 */
export async function remoteDeleteFile(
  machineId: string,
  envId: string,
  filePath: string,
): Promise<{ ok: boolean }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "delete", { path: filePath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { ok: boolean };
}

/** 重命名远程文件/目录 */
export async function remoteRename(
  machineId: string,
  envId: string,
  oldPath: string,
  newPath: string,
): Promise<{ oldPath: string; newPath: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "rename", {
    oldPath,
    newPath,
    environmentId: envId,
  });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { oldPath: string; newPath: string };
}

/** 创建远程目录 */
export async function remoteMkdir(
  machineId: string,
  envId: string,
  dirPath: string,
): Promise<{ path: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "mkdir", { path: dirPath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { path: string };
}

/** 递归列出远程 user/ 下所有路径 */
export async function remoteTree(
  machineId: string,
  envId: string,
): Promise<string[]> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "tree", { environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return (result.data as { paths: string[] }).paths;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/remote-file-service.ts
git commit -m "feat(remote-file): add remote file service with all file operations"
```

---

## Task 5: acp-link — 文件操作处理器

**Files:**
- Create: `packages/acp-link/src/client/file-operations.ts`

acp-link 侧的文件操作处理器，接收 `file_op` 消息，执行本地文件系统操作，返回 `file_op_result`。

- [ ] **Step 1: 创建 `packages/acp-link/src/client/file-operations.ts`**

```typescript
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";

// ── 文本扩展名检测（与 RCS workspace-fs.ts 保持一致）──────────

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".ts", ".js", ".tsx", ".jsx",
  ".py", ".go", ".rs", ".css", ".html", ".xml", ".toml", ".ini", ".cfg",
  ".sh", ".bash", ".zsh", ".sql", ".env",
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
  ".jsx": "text/javascript", ".json": "application/json", ".xml": "application/xml",
  ".txt": "text/plain", ".md": "text/plain", ".yaml": "text/plain", ".yml": "text/plain",
  ".py": "text/plain", ".go": "text/plain", ".rs": "text/plain",
  ".sh": "text/plain", ".bash": "text/plain", ".zsh": "text/plain",
  ".sql": "text/plain", ".csv": "text/csv", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

function isTextExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext);
}

function getMimeType(ext: string): string {
  return MIME_TYPES[ext] || "application/octet-stream";
}

/** 检测文件是否为文本文件（前 8KB 无 NULL 字节） */
async function isTextFile(filePath: string): Promise<boolean> {
  try {
    const buffer = Buffer.alloc(8192);
    const file = await open(filePath, "r");
    const { bytesRead } = await file.read(buffer, 0, 8192, 0);
    await file.close();
    return !buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  }
}

// ── Workspace 路径解析 ──────────────────────────────

/**
 * 根据 environmentId 计算 workspace 路径。
 * 公式与 RCS 的 resolveWorkspacePath 一致：
 * {WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}
 *
 * 注意：在 acp-link client mode 中，我们不知道 organizationId 和 userId。
 * 因此需要一个替代方案：维护 environmentId → workspace 的映射。
 */
const workspaceCache = new Map<string, string>();

/** 注册 environmentId → workspace 映射（由 InstanceManager.prepare 调用） */
export function registerWorkspace(environmentId: string, workspace: string): void {
  workspaceCache.set(environmentId, workspace);
  console.log(`[file-ops] Registered workspace: ${environmentId} → ${workspace}`);
}

/** 获取 environmentId 对应的 workspace 路径 */
function getWorkspace(environmentId: string): string | null {
  return workspaceCache.get(environmentId) ?? null;
}

// ── 路径安全校验 ──────────────────────────────

/** 解析并验证路径在 workspace 范围内 */
function resolveAndValidate(
  workspace: string,
  relativePath: string,
): { resolved: string; displayPath: string } | null {
  // 处理 user/ 前缀
  let cleanPath = relativePath.trim();
  const isUserPath = cleanPath === "" || cleanPath === "user" || cleanPath.startsWith("user/");

  const baseDir = isUserPath ? join(workspace, "user") : workspace;

  if (isUserPath) {
    if (cleanPath.startsWith("user/")) cleanPath = cleanPath.slice(5);
    else if (cleanPath === "user") cleanPath = "";
  }

  const resolvedPath = resolve(baseDir, cleanPath);

  // 路径遍历检查
  if (!resolvedPath.startsWith(`${baseDir}/`) && resolvedPath !== baseDir) {
    return null;
  }

  const relPath = relative(baseDir, resolvedPath);
  const displayPath = isUserPath ? (relPath ? `user/${relPath}` : "user") : relPath || ".";

  return { resolved: resolvedPath, displayPath };
}

// ── 操作处理器 ──────────────────────────────

interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: number;
}

function shouldHideEntry(entryPath: string, userDir: string): boolean {
  const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
  if (inUserDir) return false;
  return entryPath.endsWith("/.opencode") || entryPath.endsWith("/.opencode/");
}

async function handleList(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ entries: FileEntry[] }> {
  const queryPath = (params.path as string) || "";
  const workspaceDir = workspace;
  const userDir = join(workspace, "user");

  await mkdir(userDir, { recursive: true });

  const resolved = resolveAndValidate(workspace, queryPath);
  if (!resolved) throw new Error("Invalid path");

  const dirInfo = await stat(resolved.resolved);
  if (!dirInfo.isDirectory()) throw new Error("Not a directory");

  const entries = await readdir(resolved.resolved, { withFileTypes: true });
  const visibleEntries = entries.filter(
    (entry) => !shouldHideEntry(join(resolved!.resolved, entry.name), userDir),
  );

  const fileEntries = await Promise.all(
    visibleEntries.map(async (entry) => {
      const entryPath = join(resolved!.resolved, entry.name);
      const statInfo = await stat(entryPath);
      const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
      const relPath = relative(inUserDir ? userDir : workspaceDir, entryPath);
      const path = inUserDir
        ? entry.isDirectory()
          ? `user/${relPath}/`
          : `user/${relPath}`
        : entry.isDirectory()
          ? `${relPath}/`
          : relPath;

      return {
        name: entry.name,
        path,
        type: (entry.isDirectory() ? "dir" : "file") as "dir" | "file",
        size: entry.isFile() ? statInfo.size : 0,
        modifiedAt: statInfo.mtimeMs,
      };
    }),
  );

  return { entries: fileEntries };
}

async function handleStat(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ size: number; isDirectory: boolean; modifiedAt: number }> {
  const filePath = params.path as string;
  const resolved = resolveAndValidate(workspace, filePath);
  if (!resolved) throw new Error("Invalid path");

  const info = await stat(resolved.resolved);
  return {
    size: info.size,
    isDirectory: info.isDirectory(),
    modifiedAt: info.mtimeMs,
  };
}

async function handleRead(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ name: string; path: string; content: string; size: number; encoding: string }> {
  const filePath = params.path as string;
  const resolved = resolveAndValidate(workspace, filePath);
  if (!resolved) throw new Error("Invalid path");

  const info = await stat(resolved.resolved);
  if (info.isDirectory()) throw new Error("Path is a directory");

  const content = await readFile(resolved.resolved, "utf-8");
  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);

  return {
    name: fileName,
    path: resolved.displayPath,
    content,
    size: info.size,
    encoding: "utf-8",
  };
}

async function handleReadBinary(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ name: string; path: string; data: string; size: number; mimeType: string }> {
  const filePath = params.path as string;
  const resolved = resolveAndValidate(workspace, filePath);
  if (!resolved) throw new Error("Invalid path");

  const info = await stat(resolved.resolved);
  if (info.isDirectory()) throw new Error("Path is a directory");

  const buffer = await readFile(resolved.resolved);
  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
  const lastDot = filePath.lastIndexOf(".");
  const lastSlash = filePath.lastIndexOf("/");
  const ext = lastDot > lastSlash ? filePath.substring(lastDot) : "";

  return {
    name: fileName,
    path: resolved.displayPath,
    data: buffer.toString("base64"),
    size: info.size,
    mimeType: getMimeType(ext),
  };
}

async function handleWrite(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ name: string; path: string; size: number }> {
  const filePath = params.path as string;
  const content = params.content as string;

  const resolved = resolveAndValidate(workspace, filePath);
  if (!resolved) throw new Error("Invalid path");

  await mkdir(resolve(resolved.resolved, ".."), { recursive: true });
  await writeFile(resolved.resolved, content, "utf-8");

  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
  const normalizedPath = filePath.startsWith("user/") ? filePath : `user/${filePath}`;

  return {
    name: fileName,
    path: normalizedPath,
    size: Buffer.byteLength(content),
  };
}

async function handleUpload(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ files: Array<{ name: string; path: string; size: number }> }> {
  const dir = (params.dir as string) || "user";
  const files = params.files as Array<{ name: string; content: string; relativePath: string }>;

  const dirResolved = resolveAndValidate(workspace, dir);
  if (!dirResolved) throw new Error("Invalid destination directory");

  await mkdir(dirResolved.resolved, { recursive: true });

  const uploaded: Array<{ name: string; path: string; size: number }> = [];

  for (const file of files) {
    const buffer = Buffer.from(file.content, "base64");
    const destPath = join(dirResolved.resolved, file.relativePath || file.name);
    await mkdir(resolve(destPath, ".."), { recursive: true });
    await writeFile(destPath, buffer);

    const relDir = dir.startsWith("user/") ? dir : dir === "user" ? "user" : `user/${dir}`;
    uploaded.push({
      name: file.name,
      path: `${relDir}/${file.relativePath || file.name}`.replace(/\/+/g, "/"),
      size: buffer.length,
    });
  }

  return { files: uploaded };
}

async function handleDelete(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const filePath = params.path as string;
  const resolved = resolveAndValidate(workspace, filePath);
  if (!resolved) throw new Error("Invalid path");

  const info = await stat(resolved.resolved);
  if (info.isDirectory()) throw new Error("Cannot delete directories");

  await unlink(resolved.resolved);
  return { ok: true };
}

async function handleRename(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ oldPath: string; newPath: string }> {
  const oldPath = params.oldPath as string;
  const newPath = params.newPath as string;

  const oldResolved = resolveAndValidate(workspace, oldPath);
  if (!oldResolved) throw new Error("Invalid source path");

  const newResolved = resolveAndValidate(workspace, newPath);
  if (!newResolved) throw new Error("Invalid destination path");

  await mkdir(resolve(newResolved.resolved, ".."), { recursive: true });
  await rename(oldResolved.resolved, newResolved.resolved);

  return { oldPath, newPath };
}

async function handleMkdir(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ path: string }> {
  const dirPath = params.path as string;
  const resolved = resolveAndValidate(workspace, dirPath);
  if (!resolved) throw new Error("Invalid path");

  await mkdir(resolved.resolved, { recursive: true });
  return { path: dirPath };
}

async function handleTree(
  workspace: string,
): Promise<{ paths: string[] }> {
  const userDir = join(workspace, "user");
  await mkdir(userDir, { recursive: true });

  const results: string[] = [];

  async function walk(dirPath: string, prefix: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const dirs: { name: string; fullPath: string; relPath: string }[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dirPath, entry.name);
      if (shouldHideEntry(fullPath, userDir)) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, fullPath, relPath });
      } else {
        files.push(relPath);
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort();

    for (const d of dirs) {
      results.push(`${d.relPath}/`);
      await walk(d.fullPath, d.relPath);
    }

    results.push(...files);
  }

  await walk(userDir, "");
  return { paths: results };
}

// ── 主入口 ──────────────────────────────

/**
 * 处理 file_op 消息，返回 file_op_result 消息体。
 * 由 server.ts 的 createAcpClient 调用。
 */
export async function handleFileOp(
  msg: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = msg.operation as string;
  const params = (msg.params as Record<string, unknown>) ?? {};
  const environmentId = params.environmentId as string;

  const requestId = msg.request_id as string;

  try {
    const workspace = getWorkspace(environmentId);
    if (!workspace) {
      return {
        type: "file_op_result",
        request_id: requestId,
        status: "error",
        error: `Workspace not found for environment: ${environmentId}`,
      };
    }

    let data: unknown;
    switch (operation) {
      case "list":
        data = await handleList(workspace, params);
        break;
      case "stat":
        data = await handleStat(workspace, params);
        break;
      case "read":
        data = await handleRead(workspace, params);
        break;
      case "read_binary":
        data = await handleReadBinary(workspace, params);
        break;
      case "write":
        data = await handleWrite(workspace, params);
        break;
      case "upload":
        data = await handleUpload(workspace, params);
        break;
      case "delete":
        data = await handleDelete(workspace, params);
        break;
      case "rename":
        data = await handleRename(workspace, params);
        break;
      case "mkdir":
        data = await handleMkdir(workspace, params);
        break;
      case "tree":
        data = await handleTree(workspace);
        break;
      default:
        return {
          type: "file_op_result",
          request_id: requestId,
          status: "error",
          error: `Unknown operation: ${operation}`,
        };
    }

    return {
      type: "file_op_result",
      request_id: requestId,
      status: "ok",
      data,
    };
  } catch (err) {
    return {
      type: "file_op_result",
      request_id: requestId,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/acp-link/src/client/file-operations.ts
git commit -m "feat(acp-link): add file operations handler for remote FS access"
```

---

## Task 6: acp-link — 集成文件操作到 client mode

**Files:**
- Modify: `packages/acp-link/src/server.ts`
- Modify: `packages/acp-link/src/client/instance-manager.ts`

在 `createAcpClient` 中：
1. 在 `registered` 回调后建立第二条 WS 到 `/acp/file-ws`
2. 在 `ws.onmessage` 的 switch 中添加 `file_op` case
3. 在 `InstanceManager.prepare` 中调用 `registerWorkspace` 注册 workspace 映射

- [ ] **Step 1: 修改 `packages/acp-link/src/client/instance-manager.ts` — 注册 workspace 映射**

在文件顶部的 import 区添加：

```typescript
import { registerWorkspace } from "./file-operations.js";
```

在 `prepare()` 方法中，`this.instances.set(instanceId, {...})` 之前添加：

```typescript
    // 注册 workspace 映射供 file-operations 使用
    if (launchSpec.environmentId) {
      registerWorkspace(launchSpec.environmentId, workspace);
    }
```

- [ ] **Step 2: 修改 `packages/acp-link/src/server.ts` — 建立第二条 WS + 处理 file_op**

在文件顶部 import 区添加：

```typescript
import { handleFileOp } from "./client/file-operations.js";
```

在 `createAcpClient` 函数内部，添加 file-ws 连接相关变量（在 `let ws` 声明附近）：

```typescript
  let fileWs: WebSocket | null = null;
  let fileWsHeartbeat: ReturnType<typeof setInterval> | null = null;
```

在 `ws.onopen` 回调中 `registered` case 的末尾（`heartbeatTimer = setInterval(...)` 之后），添加建立 file-ws 连接的逻辑：

```typescript
            // 建立 file-ws 连接
            const fileWsUrl = `${config.rcsUrl}/acp/file-ws?secret=${encodeURIComponent(config.rcsSecret ?? "")}`;
            const connectFileWs = () => {
              fileWs = new WebSocket(fileWsUrl);
              fileWs.onopen = () => {
                console.log("[acp-client] file-ws connected, registering...");
                fileWs!.send(JSON.stringify({ type: "register", machine_id: msg.machine_id }));
                fileWsHeartbeat = setInterval(() => {
                  if (fileWs && fileWs.readyState === 1) {
                    fileWs.send(JSON.stringify({ type: "keep_alive" }));
                  }
                }, 30000);
              };
              fileWs.onmessage = async (event) => {
                try {
                  const fmsg = JSON.parse(event.data as string);
                  if (fmsg.type === "file_op") {
                    const result = await handleFileOp(fmsg);
                    if (fileWs && fileWs.readyState === 1) {
                      fileWs.send(JSON.stringify(result));
                    }
                  }
                } catch {
                  // ignore
                }
              };
              fileWs.onclose = () => {
                if (fileWsHeartbeat) {
                  clearInterval(fileWsHeartbeat);
                  fileWsHeartbeat = null;
                }
                if (!manualClose) {
                  // 重连 file-ws
                  setTimeout(connectFileWs, 5000);
                }
              };
              fileWs.onerror = () => {
                // onclose will handle
              };
            };
            connectFileWs();
```

在 `createAcpClient` 的 `close()` 方法中，在 `ws?.close()` 之前添加：

```typescript
      if (fileWsHeartbeat) clearInterval(fileWsHeartbeat);
      fileWs?.close();
```

- [ ] **Step 3: Commit**

```bash
git add packages/acp-link/src/server.ts packages/acp-link/src/client/instance-manager.ts
git commit -m "feat(acp-link): integrate file-ws connection into client mode"
```

---

## Task 7: RCS 路由层 — `files.ts` 远程分支

**Files:**
- Modify: `src/routes/web/files.ts`

在 `files.ts` 的每个路由处理函数中，`requireEnv` 之后、文件操作之前，插入远程环境判断。远程时调用 `remote-file-service`。

- [ ] **Step 1: 添加 import**

在 `files.ts` 文件顶部 import 区添加：

```typescript
import { getRemoteMachineId } from "../../services/remote-file-service";
import * as remoteFile from "../../services/remote-file-service";
```

- [ ] **Step 2: 修改 `GET /:id/user`（list）**

将当前的处理逻辑替换为：

```typescript
app.get(
  "/:id/user",
  async ({ store, params, query, error }) => {
    const authCtx = store.authContext!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, error);
    const queryPath = (query as Record<string, string | undefined>)?.path || "";

    // 远程环境：通过 file-ws 转发
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        const entries = await remoteFile.remoteListDir(machineId, envId, queryPath);
        return { entries };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    // 本地环境：原有逻辑
    const result = await resolveWorkspacePath(envId, queryPath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    const { userDir, workspaceDir, resolved } = result;
    const info = await stat(resolved);
    if (!info.isDirectory()) return error(400, { error: { type: "validation_error", message: "Not a directory" } });

    const items = await listDirectory(resolved, userDir, workspaceDir);
    return { entries: items };
  },
  { sessionAuth: true },
);
```

- [ ] **Step 3: 修改 `GET /:id/user/*`（read）**

```typescript
app.get(
  "/:id/user/*",
  async ({ store, params, query, error, set }) => {
    const authCtx = store.authContext!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    const filePath = normalizeUserRoutePath((params as any)["*"] as string);
    const preview = (query as Record<string, string | undefined>)?.preview === "true";

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        if (preview) {
          const binResult = await remoteFile.remoteReadBinaryFile(machineId, envId, filePath);
          const ext = filePath.substring(filePath.lastIndexOf("."));
          set.headers["Content-Type"] = getMimeType(ext);
          set.headers["Content-Security-Policy"] =
            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * blob:; connect-src *";
          const buffer = Buffer.from(binResult.data, "base64");
          return new Response(buffer);
        }

        const ext = filePath.substring(filePath.lastIndexOf("."));
        if (isTextExtension(ext)) {
          const result = await remoteFile.remoteReadFile(machineId, envId, filePath);
          return { name: result.name, path: result.path, content: result.content, size: result.size, encoding: result.encoding };
        }

        // 尝试文本读取，如果不是文本则走二进制
        try {
          const result = await remoteFile.remoteReadFile(machineId, envId, filePath);
          return { name: result.name, path: result.path, content: result.content, size: result.size, encoding: result.encoding };
        } catch {
          const binResult = await remoteFile.remoteReadBinaryFile(machineId, envId, filePath);
          const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
          set.headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
          set.headers["Content-Type"] = "application/octet-stream";
          const buffer = Buffer.from(binResult.data, "base64");
          return new Response(buffer);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    // 本地环境：原有逻辑不变
    const result = await resolveWorkspacePath(envId, filePath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    const { resolved, displayPath } = result;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(resolved);
    } catch {
      return error(404, { error: { type: "not_found", message: "File not found" } });
    }
    if (info.isDirectory())
      return error(400, { error: { type: "validation_error", message: "Path is a directory, use list endpoint" } });

    const lastDot = filePath.lastIndexOf(".");
    const lastSlash = filePath.lastIndexOf("/");
    const ext = lastDot > lastSlash ? filePath.substring(lastDot) : "";

    if (preview) {
      set.headers["Content-Type"] = getMimeType(ext);
      set.headers["Content-Security-Policy"] =
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * blob:; connect-src *";
      // biome-ignore lint/suspicious/noExplicitAny: ReadableStream type mismatch with Response constructor
      return new Response(createFileStream(resolved) as any);
    }

    const textFile = isTextExtension(ext) || (!ext && (await isTextFile(resolved)));
    const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);

    if (textFile) {
      const { content, size } = await readFileContent(resolved);
      return { name: fileName, path: displayPath, content, size, encoding: "utf-8" };
    }

    set.headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
    set.headers["Content-Type"] = "application/octet-stream";
    // biome-ignore lint/suspicious/noExplicitAny: ReadableStream type mismatch with Response constructor
    return new Response(createFileStream(resolved) as any);
  },
  { sessionAuth: true },
);
```

- [ ] **Step 4: 修改 `POST /:id/user/*`（upload）**

在 `requireEnv` 之后、路径解析之前，插入远程分支：

```typescript
app.post(
  "/:id/user/*",
  async ({ store, params, request, error }) => {
    const authCtx = store.authContext!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    const dirPath = normalizeUserRoutePath(((params as any)["*"] as string) || "");

    if (!isUserPath(dirPath))
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    if (!files || files.length === 0)
      return error(400, { error: { type: "validation_error", message: "No files provided" } });

    const rawPaths = formData.get("relativePaths");
    let relativePaths: string[] = [];
    if (rawPaths && typeof rawPaths === "string") {
      try {
        relativePaths = JSON.parse(rawPaths);
      } catch {
        relativePaths = [];
      }
    }

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        const remoteFiles = await Promise.all(
          files.map(async (file, i) => {
            const buffer = Buffer.from(await file.arrayBuffer());
            if (buffer.length > 50 * 1024 * 1024) {
              throw new Error(`File ${file.name} exceeds 50MB limit`);
            }
            return {
              name: file.name,
              content: buffer.toString("base64"),
              relativePath: relativePaths[i] || file.name,
            };
          }),
        );
        const result = await remoteFile.remoteUploadFiles(machineId, envId, dirPath, remoteFiles);
        return { files: result.files };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote upload failed";
        const status = message.includes("50MB") ? 413 : 503;
        return error(status, { error: { type: "remote_error", message } });
      }
    }

    // 本地环境：原有逻辑
    const result = await resolveWorkspacePath(envId, dirPath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    const { resolved } = result;
    const { mkdir, writeFile: writeFileAsync } = await import("node:fs/promises");
    await mkdir(resolved, { recursive: true });

    const uploaded: Array<{ name: string; path: string; size: number }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const buffer = Buffer.from(await file.arrayBuffer());
      if (buffer.length > 50 * 1024 * 1024) {
        return error(413, { error: { type: "validation_error", message: `File ${file.name} exceeds 50MB limit` } });
      }

      const relPath = relativePaths[i] || file.name;
      const destPath = join(resolved, relPath);
      const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
      await mkdir(destDir, { recursive: true });
      await writeFileAsync(destPath, buffer);

      uploaded.push({
        name: file.name,
        path: `user/${dirPath ? `${dirPath.replace(/^user\/?/, "")}/` : ""}${relPath}`.replace("user//", "user/"),
        size: buffer.length,
      });
    }
    return { files: uploaded };
  },
  { sessionAuth: true },
);
```

- [ ] **Step 5: 修改 `PUT /:id/user/*`（write）**

在 `requireEnv` 之后插入远程分支：

```typescript
app.put(
  "/:id/user/*",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    const filePath = normalizeUserRoutePath((params as any)["*"] as string);

    if (!isUserPath(filePath))
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

    const b = body as { content?: string };
    if (typeof b.content !== "string")
      return error(400, { error: { type: "validation_error", message: "content field required" } });

    if (b.content.length > 100 * 1024 * 1024)
      return error(413, { error: { type: "validation_error", message: "Content exceeds 100MB limit" } });

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        const result = await remoteFile.remoteWriteFile(machineId, envId, filePath, b.content);
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote write failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    // 本地环境
    const result = await resolveWorkspacePath(envId, filePath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    await writeFileContent(result.resolved, b.content);

    const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
    const normalizedPath = filePath.startsWith("user/") ? filePath : `user/${filePath}`;
    return { name: fileName, path: normalizedPath, size: Buffer.byteLength(b.content) };
  },
  { sessionAuth: true, body: "write-file-request" },
);
```

- [ ] **Step 6: 修改 `DELETE /:id/user/*`（delete）**

在 `requireEnv` 之后插入远程分支：

```typescript
app.delete(
  "/:id/user/*",
  async ({ store, params, error }) => {
    const authCtx = store.authContext!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    const filePath = normalizeUserRoutePath((params as any)["*"] as string);

    if (!isUserPath(filePath))
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        await remoteFile.remoteDeleteFile(machineId, envId, filePath);
        return { ok: true as const };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote delete failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    // 本地环境
    const result = await resolveWorkspacePath(envId, filePath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    try {
      const info = await stat(result.resolved);
      if (info.isDirectory())
        return error(400, { error: { type: "validation_error", message: "Cannot delete directories" } });
    } catch {
      return error(404, { error: { type: "not_found", message: "File not found" } });
    }

    await deleteFile(result.resolved);
    return { ok: true as const };
  },
  { sessionAuth: true },
);
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/web/files.ts
git commit -m "feat(remote-file): add remote branch to file routes"
```

---

## Task 8: RCS 路由层 — `user-file.ts` 远程分支

**Files:**
- Modify: `src/routes/web/user-file.ts`

与 Task 7 相同模式，在每个路由中添加远程分支。

- [ ] **Step 1: 添加 import**

在 `user-file.ts` 顶部 import 区添加：

```typescript
import { getRemoteMachineId } from "../../services/remote-file-service";
import * as remoteFile from "../../services/remote-file-service";
```

- [ ] **Step 2: 修改 `GET /:id/user-file/tree`**

```typescript
app.get(
  "/:id/user-file/tree",
  async ({ store, params, error }) => {
    const authCtx = store.authContext!;
    const env = await requireEnv(params.id, authCtx.organizationId, error);
    if (env instanceof Response) return env;

    // 远程环境
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      try {
        const paths = await remoteFile.remoteTree(machineId, params.id);
        return { paths };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote tree operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    // 本地环境
    const resolved = await resolveWorkspacePath(params.id, ".");
    if (!resolved) return error(404, { error: { type: "not_found", message: "工作区不存在" } });
    const paths = await listPathsRecursive(resolved.workspaceDir);
    return { paths };
  },
  { sessionAuth: true },
);
```

- [ ] **Step 3: 修改 `POST /:id/user-file/rename`**

```typescript
app.post(
  "/:id/user-file/rename",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    await requireEnv(params.id, authCtx.organizationId, error);
    const { oldPath, newPath } = body as { oldPath: string; newPath: string };

    if (!isUserPath(oldPath) || !isUserPath(newPath)) {
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are allowed" } });
    }

    // 远程环境
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      try {
        return await remoteFile.remoteRename(machineId, params.id, oldPath, newPath);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote rename failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    // 本地环境
    const oldResolved = await resolveWorkspacePath(params.id, oldPath);
    if (!oldResolved) return error(404, { error: { type: "not_found", message: "Source not found" } });

    try {
      await stat(oldResolved.resolved);
    } catch {
      return error(404, { error: { type: "not_found", message: "Source not found" } });
    }

    const newResolved = await resolveWorkspacePath(params.id, newPath);
    if (!newResolved) return error(400, { error: { type: "validation_error", message: "Invalid destination" } });

    await renamePath(oldResolved.resolved, newResolved.resolved);
    return { oldPath, newPath };
  },
  { sessionAuth: true, body: "rename-request" },
);
```

- [ ] **Step 4: 修改 `POST /:id/user-file/mkdir`**

```typescript
app.post(
  "/:id/user-file/mkdir",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    await requireEnv(params.id, authCtx.organizationId, error);
    const { path } = body as { path: string };

    if (!isUserPath(path)) {
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are allowed" } });
    }

    // 远程环境
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      try {
        return await remoteFile.remoteMkdir(machineId, params.id, path);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote mkdir failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    // 本地环境
    const resolved = await resolveWorkspacePath(params.id, path);
    if (!resolved) return error(400, { error: { type: "validation_error", message: "Invalid path" } });

    await mkdirp(resolved.resolved);
    return { path };
  },
  { sessionAuth: true, body: "mkdir-request" },
);
```

- [ ] **Step 5: 修改 `DELETE /:id/user-file/batch`**

```typescript
app.delete(
  "/:id/user-file/batch",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    await requireEnv(params.id, authCtx.organizationId, error);
    const { paths } = body as { paths: string[] };

    // 远程环境
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      const deleted: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      for (const p of paths) {
        if (!isUserPath(p)) {
          failed.push({ path: p, error: "Only user/ paths are allowed" });
          continue;
        }
        try {
          await remoteFile.remoteDeleteFile(machineId, params.id, p);
          deleted.push(p);
        } catch (e) {
          failed.push({ path: p, error: e instanceof Error ? e.message : "Unknown error" });
        }
      }
      return { deleted, failed };
    }

    // 本地环境
    const deleted: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    for (const p of paths) {
      if (!isUserPath(p)) {
        failed.push({ path: p, error: "Only user/ paths are allowed" });
        continue;
      }
      try {
        const resolved = await resolveWorkspacePath(params.id, p);
        if (!resolved) {
          failed.push({ path: p, error: "Not found" });
          continue;
        }
        const info = await stat(resolved.resolved);
        if (info.isDirectory()) {
          failed.push({ path: p, error: "Cannot delete directories" });
          continue;
        }
        await deleteFile(resolved.resolved);
        deleted.push(p);
      } catch (e) {
        failed.push({ path: p, error: e instanceof Error ? e.message : "Unknown error" });
      }
    }

    return { deleted, failed };
  },
  { sessionAuth: true, body: "batch-delete-request" },
);
```

- [ ] **Step 6: 修改 `GET /:id/user-file/download-zip`**

远程环境的 download-zip 需要 acp-link 先 zip 打包再 base64 传回，考虑到大文件的性能问题，暂时对远程环境返回 501 Not Implemented，后续通过 HTTP 流式代理优化。

```typescript
app.get(
  "/:id/user-file/download-zip",
  async ({ store, params, query, error, set }) => {
    const authCtx = store.authContext!;
    const env = await requireEnv(params.id, authCtx.organizationId, error);
    if (env instanceof Response) return env;

    const path = (query as Record<string, string | undefined>)?.path;
    if (!path) return error(400, { error: { type: "validation_error", message: "path query parameter required" } });
    if (!isUserPath(path))
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are allowed" } });

    // 远程环境：暂不支持 zip 下载（需 WS 传输 base64，大文件性能差）
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      return error(501, {
        error: { type: "not_implemented", message: "远程环境暂不支持目录打包下载" },
      });
    }

    // 本地环境
    const resolved = await resolveWorkspacePath(params.id, path);
    if (!resolved) return error(404, { error: { type: "not_found", message: "Path not found" } });

    try {
      const info = await stat(resolved.resolved);
      if (!info.isDirectory())
        return error(400, { error: { type: "validation_error", message: "Path is not a directory" } });
    } catch {
      return error(404, { error: { type: "not_found", message: "Path not found" } });
    }

    const dirName = path.split("/").filter(Boolean).pop() || "download";
    set.headers["Content-Type"] = "application/zip";
    set.headers["Content-Disposition"] = `attachment; filename="${dirName}.zip"`;

    const zipProcess = spawn("zip", ["-r", "-q", "-", "."], {
      cwd: resolved.resolved,
      stdio: ["ignore", "pipe", "ignore"],
    });

    // biome-ignore lint/suspicious/noExplicitAny: ReadableStream type mismatch
    return new Response(zipProcess.stdout as any);
  },
  { sessionAuth: true },
);
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/web/user-file.ts
git commit -m "feat(remote-file): add remote branch to user-file routes"
```

---

## Task 9: 类型检查和构建验证

**Files:** 无新改动，验证已有代码。

- [ ] **Step 1: 运行 TypeScript 类型检查**

```bash
bunx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 2: 运行 precheck**

```bash
bun run precheck
```

Expected: format + import sort + tsc + biome check 全部通过

- [ ] **Step 3: 运行现有测试确保无回归**

```bash
bun test src/__tests__/
```

Expected: 所有测试通过

- [ ] **Step 4: 修复任何问题并 Commit**

如有修复：
```bash
git add -A
git commit -m "fix: resolve type/lint issues from remote file system changes"
```

---

## Self-Review Checklist

### 1. Spec Coverage

| 需求 | 对应 Task |
|------|-----------|
| RCS `/acp/file-ws` 端点 | Task 2 + Task 3 |
| file-ws 连接管理和消息路由 | Task 2 |
| 远程文件操作客户端 | Task 4 |
| acp-link 文件操作处理器 | Task 5 |
| acp-link 第二条 WS 连接 | Task 6 |
| workspace 映射注册 | Task 6 |
| files.ts 远程分支 | Task 7 |
| user-file.ts 远程分支 | Task 8 |
| 类型检查和测试 | Task 9 |

### 2. Placeholder Scan

无 TBD/TODO/占位符。所有代码步骤都包含完整实现。

### 3. Type Consistency

- `FileWsConnectionEntry` 在 Task 1 定义，Task 2 使用
- `sendFileOpAndWait` 在 Task 2 定义，Task 4 的 `remote-file-service.ts` 调用
- `handleFileOp` 在 Task 5 定义，Task 6 的 `server.ts` 调用
- `registerWorkspace` 在 Task 5 定义，Task 6 的 `instance-manager.ts` 调用
- `getRemoteMachineId` 和 `remote*` 函数在 Task 4 定义，Task 7/8 的路由层调用
- 所有操作名（`list`, `read`, `write` 等）在 Task 5 的 switch 和 Task 4 的调用之间一致

### 遗留问题

1. **download-zip 远程不支持**：Task 8 中远程环境的 zip 下载返回 501。后续可通过在 acp-link 上添加 HTTP 端点实现流式代理。
2. **workspace 映射依赖 `InstanceManager.prepare`**：只有经过 prepare 的 environment 才有 workspace 映射。如果 environment 从未被 spawn 过实例，文件操作会返回 "Workspace not found"。
3. **acp-link-rs 兼容性**：Rust 实现目前为空，后续需遵循同一 WS 协议。
