# WebSocket → socket.io 迁移影响报告

> 日期：2026-07-14
> 涉及文件：30 个

## 一、迁移概述

将 RCS Server 的 WebSocket 层从 Elysia `app.ws()` 迁移到 socket.io Server（含 Redis Adapter 支持多节点水平扩展）。

**变更文件**：`src/index.ts`、`src/routes/acp/index.ts`、`packages/acp-link/src/server.ts` 等 30 个文件。

## 二、三条通信链路迁移状态

### 链路 1：浏览器 Chat UI → RCS（`/relay`）

| 维度 | 旧实现 | 新实现 |
|------|--------|--------|
| 连接地址 | `ws://host/acp/relay/:agentId?sessionId=xxx`（Elysia 原生 WS） | socket.io `/relay` namespace |
| 认证方式 | URL 路径参数 | query 参数 `agentId`、`sessionId`、`activeOrganizationId` |
| 适配端 | — | 前端 `ACPClient`（`web/src/acp/relay-client.ts`）已使用 socket.io-client |
| 状态 | — | ✅ 已完成 |

### 链路 2：acp-link 远端机器 → RCS（`/machine`）

| 维度 | 旧实现 | 新实现 |
|------|--------|--------|
| 连接地址 | `ws://host/acp/ws?secret=REGISTRY_SECRET`（Elysia 原生 WS） | socket.io `/machine` namespace |
| 认证方式 | URL query 参数 `secret` | socket.io handshake query 参数 `secret` |
| 适配端 | — | `packages/acp-link/src/server.ts` 的 `createAcpClient` 函数已从原生 WebSocket 改为 socket.io-client |
| 核心改动 | `new WebSocket(url)` | `io("${rcsUrl}/machine", { query: { secret }, transports: ["websocket"] })` |
| 状态 | — | ✅ 已完成（本分支已适配） |

### 链路 3：acp-link 文件传输 → RCS（`/file`）

| 维度 | 旧实现 | 新实现 |
|------|--------|--------|
| 连接地址 | `ws://host/acp/file-ws?secret=REGISTRY_SECRET`（Elysia 原生 WS） | socket.io `/file` namespace |
| 认证方式 | URL query 参数 `secret` | socket.io handshake query 参数 `secret`、`machine_id` |
| 适配端 | — | 同上 `packages/acp-link/src/server.ts` |
| 核心改动 | `new WebSocket(fileWsUrl)` | `io("${rcsUrl}/file", { query: { secret, machine_id }, transports: ["websocket"] })` |
| 状态 | — | ✅ 已完成（本分支已适配） |

## 三、升级策略

| 端 | 是否必须同步 | 原因 |
|------|---------|------|
| RCS Server | ✅ 必须 | 旧 Elysia WS 路由已删除 |
| 前端 Chat UI | ✅ 必须 | 本分支已包含适配 |
| acp-link 客户端 | ✅ 必须 | 本分支已包含适配 |
| API `wsUrl` 返回值 | ⚠️ 不影响功能 | `src/services/api-instance.ts` 返回旧 URL 格式，但调用方不依赖 |

## 四、技术收益

1. **多节点水平扩展**：Redis Adapter 实现跨节点广播，relay / machine / file 三个 namespace 的消息可跨 RCS 实例投递
2. **TransportStore 跨节点状态**：instance → relay socketId 映射存储在 Redis / Memory，支持跨节点查询
3. **EventBus 跨节点通知**：session 事件通过 TransportStore Pub/Sub 广播到其他节点
4. **简化客户端**：删除手动心跳和指数退避重连逻辑（−90 行），由 socket.io 内置机制接管
5. **统一协议栈**：所有四条线（前端 relay + 机器 machine + 文件 file + 服务间 eventbus）统一使用 socket.io 生态

## 五、回滚兼容性

- **不可回滚**：旧 Elysia `.ws()` 路由已彻底删除，无法通过降级 RCS Server 恢复（acp-link 和前端已改为 socket.io-client，原生 WebSocket URL 不再可用）
- **回滚方案**：如需降级，需同步回滚 RCS Server + acp-link + 前端 Chat UI 三个组件

## 六、部署注意事项

1. 多节点部署需配置 `RCS_REDIS_URL` 环境变量（格式 `redis://host:6379`）
2. `docker-compose.prod.yml` 已添加 `redis:7-alpine` 服务，`rcs` 的 `depends_on` 中添加了 `redis`
3. 文件传输 `/file` namespace 的注册消息新增了 `machine_id` 参数
4. 三个 namespace 的连接 timeout 均为 10s（服务端配置）、30s（客户端配置）
5. `REGISTRY_SECRET` 认证逻辑未变，仅从 URL query param 迁移到 socket.io handshake query
