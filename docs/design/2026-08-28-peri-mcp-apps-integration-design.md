# Peri MCP Apps × FenixAgent 接入初步设计

> 日期：2026-08-28
> 状态：初步方案，待跨仓协议闭环后实施
> 范围：Peri ACP stdio Agent、Fenix Engine/acp-link、Engine relay、chat-channel、Web MCP Apps Host
> 约束：默认不影响普通 ACP Agent；Apps 路径显式启用、可独立关闭，任一失败均退化为普通 tool card

## 1. 结论摘要

核心工作应放在 **Fenix Agent/Engine 的 MCP Apps 管道分流**，而不是在 Web 侧重写 MCP Apps 协议：

1. Peri 继续作为真实 MCP Client，负责 MCP capability、tool/resource 调用、canonical dispatcher、Permission/HITL 与 lease。
2. Fenix `acp-link` 在真实 `ClientSideConnection` 边界截获可信 App binding offer，调用 `peri/mcp/open|resource|app`，并保留普通 ACP tool update 原路径。
3. Engine 只向上发送去敏、typed 的 App 语义 DTO，不暴露 Peri method、lease 或任意 JSON-RPC tunnel。
4. Web Host 使用官方 `@modelcontextprotocol/ext-apps/app-bridge`；以 `AppBridge(null, ...)` 注入 Fenix transport callbacks，不自行实现 Apps handshake、schema、request ID correlation 或 lifecycle 状态机。
5. Fenix 仍负责认证授权、tenant/session/connection binding、短期资源分发、isolated sandbox origin、CSP 和 Permissions Policy。

目标链路：

```text
MCP Server
  ↕ MCP
Peri MCP pool / effective-tool dispatcher / Permission-HITL
  ↕ ACP stdio（标准 ACP + peri/mcp/* extension）
Fenix Agent/Engine: McpAppsPipeline 分流 + connection-owned registry
  ├─ 普通 ACP update ───────────────→ 现有 relay/chat/Yjs/tool card
  └─ App semantic DTO ─────────────→ McpAppsCoordinator
                                         ↕ authenticated transient API
Web Host: official AppBridge + official PostMessageTransport
  ↕ Fenix-owned cross-origin sandbox shell
Untrusted MCP App View
```

真正的 P0 有两个：

- **可信 binding 发现**：标准 ACP tool update 无法无损恢复原始 `serverId`、`toolName` 和一次性 `invocationToken`。
- **权威初始结果**：标准 ACP 已保留初始 tool `rawInput`，Fenix 可按 `toolCallId` 关联；真正缺失的是无法从普通 ACP 展示结果反向重建的原始结构化 `CallToolResult`。

## 2. 目标与非目标

### 2.1 目标

1. App-instantiating MCP tool 成功后，Fenix 能把同一 tool card 渲染成符合 MCP Apps 协议的交互式 View。
2. App 发起的 `tools/call` 仍经过 Peri 当前 turn 的 allowlist、canonical dispatcher 与 Permission/HITL。
3. 普通 ACP event、普通 Agent 和现有 Yjs 投影保持原语义。
4. token、真实 binding、raw HTML 与瞬时 App RPC 不进入 Yjs、数据库、通用日志或可回放事件。
5. process restart、新 turn、session/connection 变化和权限丢失后旧 App fail closed。

### 2.2 非目标

- 不让浏览器直连 MCP Server、ACP stdio 或持有 Peri `appSessionId`/`invocationToken`。
- 不把 `peri/mcp/app` 扩展为任意 MCP method proxy；首版只支持 App 发起的 `tools/call`。
- 不在 Fenix 重写官方 Host/App wire、protocol negotiation、JSON-RPC correlation 或 React View hooks。
- 不把 App session 做成跨 process、跨 turn、跨登录恢复的持久化对象。
- 不把 Peri-specific 逻辑散入通用 `AcpDispatcher`、`SessionChannel`、Yjs writer 或通用 iframe preview。
- 首版不提前抽象多 Agent provider；第二个真实实现出现后再提取 provider interface。

## 3. 官方 SDK 核验与选型

调查时核对了 npm tarball、README、`.d.ts` 和官方 `basic-host` 示例，而非仅依赖搜索摘要。

| 包 | 已核对版本 | 真实职责 | 本方案定位 |
|---|---:|---|---|
| `@modelcontextprotocol/ext-apps/app-bridge` | 1.7.5 | 官方 Host-side `AppBridge`、`PostMessageTransport`、types/helpers | 核心依赖，直接使用 |
| `@modelcontextprotocol/ext-apps` | 1.7.5 | App/View-side `App` 与 transport | 由 MCP App 自身使用，不是 Fenix Host renderer |
| `@modelcontextprotocol/ext-apps/react` | 1.7.5 | App/View 作者侧 `useApp`、theme/style hooks | 不作为 Fenix Host React component |
| `@mcp-ui/client` | 7.1.1 | 社区 `AppRenderer`/`AppFrame` Host React wrapper | 可做 spike，不能成为协议或授权事实源 |

关键结论：

- 官方 `AppBridge` 明确支持 `Client | null`；传 `null` 后由 Host 注册 `oncalltool`、`onreadresource` 等 handler。这正适合 Fenix 的远端 Peri relay，浏览器不需要构造假的 MCP `Client`。
- `AppBridge` 自动处理 View ↔ Host 的 `ui/initialize`、Apps protocol negotiation、schema、request/response correlation、tool lifecycle 和 teardown。
- 官方 React export 是 **View-side hooks**。官方仓库当前只有 `basic-host` 参考实现，没有受支持的 React Host renderer。
- `@mcp-ui/client` 是官方 README 提及的社区方案，且自述为 experimental。若采用，必须锁定依赖解析、审计 sandbox 默认值，并用 conformance tests 证明与固定的 `ext-apps` 版本兼容。
- Fenix 根依赖已有 `@modelcontextprotocol/sdk ^1.29.0`，与 `ext-apps@1.7.5` 的 peer range 对齐；实施时仍应 pin/lock 并复核，不在本设计任务中改 manifest。

默认选择：**直接使用官方 `AppBridge`，参考官方 `basic-host` 的 sandbox 模式；社区 React wrapper 只作为可替换的 UI convenience layer。**

## 4. 已确认的 Peri/ACP 协议事实

### 4.1 Peri deployment profile

- `PERI_MCP_APPS` 按环境变量是否存在启用，profile 在进程内不可变。
- 启用后 Peri 向 MCP peer 声明 extension `io.modelcontextprotocol/ui` 和 MIME `text/html;profile=mcp-app`。
- 未启用时不装配 Apps relay，`peri/mcp/*` fail closed。
- 该 capability 是 Peri → MCP Server，不是 ACP initialize capability；Fenix 不能从普通 ACP initialize 成功推断 Apps 可用。
- Fenix 只能在明确的 Peri launch profile、agent implementation allowlist 与合法 offer 同时满足时开启分支。

### 4.2 ACP extension RPC

| 方法 | 方向 | 作用 |
|---|---|---|
| `peri/mcp/open` | Fenix → Peri | 单次消费 pending invocation lease，创建 connection-owned binding |
| `peri/mcp/resource` | Fenix → Peri | 读取 binding 对应的 `ui://` App resource |
| `peri/mcp/app` | Fenix → Peri | 转发受限的 nested MCP `tools/call` |
| binding offer（拟新增） | Peri → Fenix | 将标准 ACP tool call 与可信 MCP identity/lease 关联 |

Fenix 已使用 `@agentclientprotocol/sdk` 1.2.0 的真实 `ClientSideConnection`。该 SDK 有泛型 custom request 能力，三个 request 不需 fork SDK；新增 offer 通过 client callback 的 `extNotification` 接收。

当前 envelope 为 `"1"`，Apps protocol 为 `"2026-01-26"`，请求模型严格拒绝未知字段。`mcpProtocolVersion` 只由 Peri response 返回，表示核心 MCP peer 协议版本；它与 View ↔ Host 的 Apps protocol version 不是同一层，也不能传给或覆盖 `AppBridge` 的自动协商。

### 4.3 Lease 与结果事实

- pending lease TTL 当前为 300 秒，raw nested-call result TTL 为 120 秒；pending/raw/active registry 均有 1024 上限。
- lease 绑定 ACP owner session、owner connection、turn generation、server generation、resource URI、原始 tool、allowed tools、canonical dispatcher 和 cancellation。
- `open` single-consume 且 non-idempotent；超时后结果不确定，禁止自动重试。
- 新 turn、session/connection close、stdio EOF、server generation 变化或 cancellation 会使 binding 失效。
- 标准 ACP `ToolCall.rawInput` 已由 Peri mapper 发出并经 Fenix normalizer 保留；Peri 当前仅为 `mcp-app:*` 的嵌套 App 调用缓存 raw `CallToolResult`，初始模型调用路径没有向 Fenix 暴露原始结构化 `CallToolResult`。后者才是 P0 bootstrap 缺口。

## 5. P0：跨仓契约闭环

### 5.1 Trusted binding offer

建议新增专用 Agent → Client extension notification；方法名在跨仓 issue 中冻结，下例仅为候选：

```json
{
  "envelopeVersion": "1",
  "appsProtocolVersion": "2026-01-26",
  "ownerSessionId": "acp-session-id",
  "toolCallId": "standard-acp-tool-call-id",
  "serverId": "raw-mcp-server-id",
  "toolName": "raw_mcp_tool_name",
  "invocationToken": "opaque-one-shot-token",
  "expiresInMs": 300000
}
```

`resourceUri` 不放在 offer 中：`open` response 已返回 authoritative URI，减少重复字段与冲突状态。

约束：

1. Peri 先成功签发 lease，再从同一不可变 lease 发送 offer；失败或 `isError: true` 不发送。
2. offer 与标准 ACP update 通过 `(connectionGeneration, ownerSessionId, toolCallId)` 汇合，允许任意到达顺序。
3. `invocationToken` 保持 opaque，即使当前与 tool-call ID 同源也单独传输。
4. `extNotification` 在调用通用 `send()` 和日志前截获；offer 不得进入普通 relay/chat/Yjs。
5. Engine 校验 schema、版本、session、generation、TTL 和 feature flag 后，至多调用一次 `open`；完成或结果不确定后立即擦除 token。
6. bounded pending map 对重复 offer 去重；未汇合、过期或异常只保留普通 tool card。

模型可见 MCP 工具名会 sanitize，转换不可逆且可能碰撞；没有 offer 时禁止拆解名称或枚举 server/tool 猜 lease。

### 5.2 Authoritative initial result 与 ACP input 汇合

官方 Host 初始化后应调用：

- `sendToolInput({ arguments })`
- `sendToolResult(callToolResult)`，失败/取消时使用对应 lifecycle notification

两份数据应从不同的权威来源汇合，不为 input 重复扩展 Peri 契约：

1. **tool input**：使用标准 ACP `ToolCall.rawInput`。Peri mapper 与 Fenix normalizer 已保留该字段；Engine Apps pipeline 按 `(connectionGeneration, ownerSessionId, toolCallId)` 截取一个有界、瞬时副本，与 offer 任意顺序汇合。
2. **tool result**：标准 ACP 展示结果不能无损表达原始结构化 `CallToolResult`。Peri 必须为初始 instantiating call 新增这一份权威数据，不能从格式化文本、普通 tool card 或 Yjs 反向重建。

推荐在 Phase 0 只把原始 initial result 绑定到 `open` 的成功结果，例如：

```json
{
  "appSessionId": "opaque-peri-binding",
  "resourceUri": "ui://server/app",
  "bootstrap": {
    "toolResult": { "content": [], "structuredContent": {}, "isError": false }
  }
}
```

这是契约示意，不代表可直接给现有 response 添加未知字段。实施前应冻结 envelope/version 迁移与 Rust/TypeScript schema。

要求：

- ACP input 只按稳定 `toolCallId` 与 owner/generation 关联，不从 title、sanitized tool name 或展示参数猜测；缺失、非 object、过期或冲突时降级。
- Peri bootstrap result 来自原始 MCP `CallToolResult`，并保留 `_meta`、`structuredContent`、`isError` 和未知字段。
- input/result 分别设置 item/total byte limit；超限、不完整或 schema 不兼容时不渲染 App，仅保留普通 card。
- 汇合后的 bootstrap 只进入 Engine transient registry，随后经认证的一次性/短期 endpoint 给当前浏览器；不持久化，也不从 Yjs 回读。
- 现有普通 ACP tool arguments 投影保持不变；不得为 Apps 再向 Yjs 写一份 bootstrap input/result。
- 若 initial result 最终采用单独 `bootstrapRef`，它必须 opaque、single-binding、短 TTL，不能复用 invocation token。

### 5.3 现有 RPC 到 Host callback 的映射

| Peri 能力 | Fenix Engine adapter | 官方 Host API |
|---|---|---|
| `open` response | 创建 `engineAppId`、保存真实 binding | 不暴露给 SDK |
| 标准 ACP `ToolCall.rawInput` | 按 owner/generation/`toolCallId` 汇合瞬时 input | `sendToolInput` |
| `open` 中新增的 initial raw `CallToolResult` | 保存并汇合瞬时 result | `sendToolResult` |
| `resource` | 校验 URI/MIME/text XOR blob/bytes，提取受控 UI metadata | `sendSandboxResourceReady({ html, csp, permissions })` |
| `app` nested `tools/call` | 返回 raw `CallToolResult` | `bridge.oncalltool` 的 Promise result |
| revoke/expiry | 撤销 handles、取消 pending | `teardownResource` + close/unmount |

首版不 advertise `serverResources`、sampling、prompts、open-link、download、message 或 fallback request。初始 App HTML 的 host-side fetch 不等于向 View 开放任意 `resources/read`。

## 6. Fenix Agent/Engine 管道分流

### 6.1 最深 fork 点

`packages/acp-link/src/client/acp-spawn-helper.ts` 创建真实 `ClientSideConnection`：标准 `sessionUpdate` 当前进入普通 `send()`，未知 extension 进入 `extNotification`。这里应成为第一 fork；标准帧只增加一个不改变转发结果的 side tap：

```text
Client callback
  ├─ sessionUpdate ──→ McpAppsPipeline.observeSessionUpdate()（仅有界截取 sessionId/toolCallId/rawInput）
  │                    └────────────────────────────────────→ 原有 send() → 普通 ACP pipeline
  ├─ 其他普通 Peri event ───────────────────────────────────→ 原有 send() → 普通 ACP pipeline
  └─ peri/mcp/binding_offer ─→ McpAppsPipeline.acceptOffer()
                                 禁止通用 send/log
```

`observeSessionUpdate()` 对所有未识别、缺字段或未启用 Apps 的 update 均为同步 no-op；无论它是否捕获 input，都不得阻塞、改写或吞掉原始 `sessionUpdate`。捕获键由 callback 参数中的 authoritative `sessionId` 与 update 的 `toolCallId` 组成，再附加 connection/turn generation；捕获的副本受容量和 TTL 约束，只用于与 offer/result 汇合。

Host → Engine 的 Apps command 也必须在 `AcpDispatcher.handleMessage()` 的通用 JSON 日志和分类之前分流；不得让浏览器构造 `peri/mcp/*` request。

所有真实 `ClientSideConnection` factory 必须复用同一 bridge factory。除 spawn helper 外，`packages/acp-link/src/server.ts` 还有直接创建路径，实施时必须一起审计，避免一条路径不支持或泄漏 offer。

### 6.2 Engine 模块 ownership

建议模块：

```text
packages/acp-link/src/client/peri-mcp-apps/
  contracts.ts       # 与 Peri serde golden fixtures 对齐的 runtime schemas
  transport.ts       # 唯一可发送 peri/mcp/open|resource|app 的窄端口
  pipeline.ts        # offer/update correlation、分流与 semantic events
  registry.ts        # connection/session/turn-scoped bindings
```

建议接口：

```ts
interface PeriMcpAppsPipeline {
  observeSessionUpdate(params: unknown): void;
  acceptOffer(input: unknown): Promise<void>;
  bootstrap(engineAppId: string): Promise<McpAppBootstrap>;
  callTool(engineAppId: string, name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  release(engineAppId: string): void;
  revokeSession(ownerSessionId: string): void;
  close(): void;
}
```

registry 保存真实 `serverId/appSessionId/resourceUri`、owner session、toolCallId、connection/turn generation、expiry 和 bootstrap；不保存已消费 token，不向上暴露 ACP connection 或 Peri method。

`InstanceState`/具体 `EngineHandler` 只拥有 pipeline 与 `connectionGeneration`，负责 process/connection start/stop。不能只按 RCS thread ID 存 registry，因为一个 ACP connection 可承载多个 ACP session。

### 6.3 Semantic relay，不做 JSON-RPC tunnel

在 `plugin-sdk` 定义独立 discriminated union，建议最小语义：

| 方向 | 消息 | 关键字段 |
|---|---|---|
| Engine → Host | `mcp_apps/v1/available` | `engineAppId`、owner ACP session、toolCallId、expiry |
| Host → Engine | `mcp_apps/v1/bootstrap` | relay request ID、`engineAppId` |
| Engine → Host | `mcp_apps/v1/bootstrap_result` | bounded resource/input/result 或稳定错误 |
| Host → Engine | `mcp_apps/v1/call_tool` | relay request ID、`engineAppId`、name、object arguments |
| Engine → Host | `mcp_apps/v1/call_result` | relay request ID、raw `CallToolResult` 或稳定错误 |
| 任一方向 | `release` / `revoked` | `engineAppId`、稳定 reason code |

不要传 App iframe JSON-RPC ID：官方 `AppBridge` 在浏览器内关联 request/response；Fenix relay 与 Engine/Peri 各自生成独立 correlation ID。

`RelayEventHandler` 在 `normalizeAcpMessage()` 前只做 typed discriminator 并委托 `McpAppsCoordinator`。coordinator 维护短期 server registry，将 `engineAppId` 重新映射为 browser-scoped `appHandle`；它不解析 Peri envelope。

### 6.4 Browser API 与 Yjs 边界

认证后的最小 DTO：

```ts
interface BrowserMcpAppBootstrap {
  appHandle: string;
  expiresAt: number;
  resource: { html: string; csp?: McpUiResourceCsp; permissions?: McpUiResourcePermissions };
  toolInput: { arguments: Record<string, unknown> };
  toolResult: CallToolResult;
}

interface BrowserMcpAppCall {
  appHandle: string;
  name: string;
  arguments: Record<string, unknown>;
}
```

`appHandle` 至少绑定 tenant、user、当前 Web connection、RCS session、instance、ACP session/generation 和 expiry；只凭 handle 不足以授权。Browser call 不包含 `serverId`、resource URI、owner session、Peri binding、allowed-tools snapshot 或任何 JSON-RPC envelope。

Yjs 只允许：

```text
toolCallId
mcpAppStatus: unavailable | loading | available | expired | failed
非授权 view correlation ID（可选）
稳定、脱敏的 reason code
```

禁止进入 Yjs/持久化：token、Peri/Engine/browser handles、raw HTML/blob、App metadata、initial raw `CallToolResult`、Apps pipeline 截取的 input 副本、App RPC、原始 server 配置。现有普通 ACP tool arguments 仍按当前 schema 投影，不因 Apps 增加第二份数据；回放发现 transient registry 不存在时显示 expired。

## 7. Web Host：注入官方 AppBridge

每个 View 创建一个 bridge；注册 handler 必须早于 `connect()`：

```ts
const bridge = new AppBridge(
  null,
  { name: "FenixAgent", version: buildVersion },
  { serverTools: {} },
  { hostContext: safeHostContext },
);

bridge.oncalltool = async ({ name, arguments: args }, extra) =>
  fenixTransport.callTool(appHandle, name, args ?? {}, extra.signal);

await bridge.connect(
  new PostMessageTransport(sandbox.contentWindow!, sandbox.contentWindow!),
);
await bridge.sendSandboxResourceReady(resource);
// 收到 initialized 后：
await bridge.sendToolInput(toolInput);
await bridge.sendToolResult(toolResult);
```

示意代码只表达依赖方向，具体 API 以实施时锁定版本的 `.d.ts` 为准。

官方 SDK 负责：

- Apps protocol negotiation 与 `ui/initialize`/`initialized` 顺序；
- JSON-RPC schema、iframe request ID correlation 和规范 response；
- tool input/result/cancel、host context、size 与 teardown lifecycle；
- View request 到已注册 Host callback 的分派。

Fenix 负责：

- bridge 外的 authenticated backend adapter 与 browser handle；
- capability 最小化、rate/size/concurrency/timeout 和 `AbortSignal` 传播；
- App resource validation、sandbox deployment 与 UI 状态；
- `oncalltool` 最终回到 Peri policy，不把本地快照当授权；
- 未注册/unknown/fallback method 一律拒绝，不透明转发。

不应实现第二套 `ui/*` 消息定义、handshake、channel ID 或 iframe request map。若使用社区 `AppFrame/AppRenderer`，只能替换 View shell，不能改变上述 transport/authorization contract。

## 8. Sandbox 与服务端安全边界

使用官方 helper 不等于完成 Host security。`PostMessageTransport` 校验 `event.source`，但发送使用 wildcard target origin；官方 `basic-host` 仍采用双 iframe、跨源 sandbox proxy。

生产要求：

1. outer sandbox 部署在与 Fenix auth cookie、localStorage、Service Worker 和业务 API 不同的 origin。
2. outer proxy 精确校验 parent `origin/source`，inner View 仅接收已验证的 HTML；复用官方协议消息，不添加自定义授权语义。
3. CSP 优先由 sandbox HTTP response header 强制；resource metadata 只能与 host allowlist 求交，不能扩大权限。
4. iframe sandbox 与 Permissions Policy 默认拒绝；camera、microphone、clipboard、geolocation、payment、USB 等只按产品审批开放。
5. URI、MIME、text XOR blob、base64、metadata depth、资源数量、单项/总 bytes、RPC arguments/result 均有独立上限。
6. invocation token、Peri binding、Engine handle、用户凭据永远不进入 iframe。
7. App 发起 tool name/arguments 只是请求；Fenix 校验身份和 binding，Peri 再校验 current turn、allowlist 与 HITL。

## 9. 端到端数据流

### 9.1 实例化与加载

```text
1. 普通 session/prompt 进入 Peri；标准 ACP update 继续原路径
2. 初始 tool update 携带 toolCallId/rawInput；Engine side tap 有界暂存，普通 tool card 同时照常投影
3. Peri 取得原始 CallToolResult；成功后签发 lease，再发送 binding offer
4. Engine 最深边界截获 offer，单次 peri/mcp/open；拟扩展 response 返回 initial raw CallToolResult
5. Engine 按 owner/generation/toolCallId 汇合 ACP rawInput、authoritative binding/result，生成 engineAppId 并擦除 token
6. 仅在汇合完整且校验成功后发送 available；普通 tool card 始终独立存在
7. Web load 时 coordinator 重新校验身份，生成 appHandle
8. Engine peri/mcp/resource → 校验/收敛 resource → transient bootstrap
9. Web 创建 official AppBridge 与 cross-origin sandbox
10. SDK 完成 Apps handshake；Host 注入 resource、tool input、tool result
```

### 9.2 App 发起工具调用

```text
1. View → official Apps wire: tools/call
2. AppBridge.oncalltool(name, arguments)
3. authenticated Fenix API 校验 user/session/appHandle
4. typed relay call_tool(engineAppId, name, arguments)
5. Engine registry 补齐 Peri binding → peri/mcp/app
6. Peri 校验 turn/allowed tool → canonical dispatcher → Permission/HITL → MCP Server
7. raw CallToolResult 返回 oncalltool
8. AppBridge 使用浏览器内原 request ID 回给 View
```

App call 可能有副作用，任一层不得自动重试。

## 10. 撤销、降级与 retry

以下事件撤销 handles、取消 pending，并向 tool card 投影 expired/revoked：新 turn；session load/resume/switch/close；ACP EOF/process exit/connection generation 变化；Engine relay/instance stop；Web 授权丢失；iframe navigation/unmount/release；TTL/quota；Peri stale/invalid/policy-denied/cancelled。

| 场景 | Apps 行为 | 普通 ACP 行为 |
|---|---|---|
| 非 Peri / flag off | 不注册 pipeline、不注入 env | 完全不变 |
| 无合法 offer/bootstrap | 不猜 identity，不渲染 App | 保留 tool card/result |
| `open` 超时/consumed/stale | 标记 expired，不重试 | turn 继续 |
| resource/SDK/sandbox 校验失败 | 安全错误或普通 card | turn 继续 |
| App call denied | 返回规范、脱敏错误 | 复用现有 HITL |
| restart/reconnect | 全部旧 handle 失效，不 replay | 新连接正常工作 |
| Yjs 回放 available | 无 registry 即 expired | 不恢复 binding |

Retry：`open` 和 `tools/call` 不自动重试；`resource` 仅在同一有效 binding 上显式、有界重试，跨 reconnect 禁止。恢复过期 App 必须重新运行 instantiating tool。

## 11. 分阶段实施

### Phase 0：contract closure

1. 两仓冻结 binding-offer schema、issuance 顺序、TTL/revoke、error/retry。
2. 冻结 initial raw `CallToolResult` 的返回方式、版本迁移和 byte limits；明确 ACP `rawInput` 的 owner/generation/`toolCallId` 汇合与清理规则。
3. 用 Peri serde model 生成 open/resource/app/offer/initial-result golden fixtures，并用标准 ACP fixture 覆盖 `rawInput` 汇合。
4. ACP SDK smoke test：custom request 可达；offer 在 `extNotification` 被截获且不进入通用 send/log。
5. pin 官方 `ext-apps`，用官方 example View 验证 `AppBridge(null)` manual `oncalltool`。
6. 定位全部 ClientSideConnection factory 与真实 Peri launch owner。

验收：无字段猜测、token 不出 Engine、raw result 不从展示文本恢复、普通 ACP fixtures 零变化。

### Phase 1：Engine pipeline dark launch

1. 实现 runtime schemas、transport、pipeline、connection-generation registry 与 cleanup。
2. 自动消费 offer、单次 open、读取/验证 resource，但不开放 Web 渲染。
3. 增加 typed semantic relay、bounds、correlation 与 cancellation。
4. feature flag + implementation allowlist + kill switch，仅输出脱敏 metrics。

验收：双 session、乱序/重复 offer、new turn、EOF、restart、open unknown outcome 全部 fail closed。

### Phase 2：Coordinator 与 transient API

1. `RelayEventHandler` 在普通 normalization 前委托 `McpAppsCoordinator`。
2. 建立 browser handle registry、bootstrap/call/release API 与 Yjs 安全状态。
3. 验证 tenant/user/Web connection/session/instance/generation 全维度绑定。

验收：token/HTML/raw result 不进入 Yjs、数据库或日志；stale/cross-tenant handle 全部拒绝。

### Phase 3：官方 Host helper 与灰度

1. 部署 cross-origin sandbox proxy 与 header CSP。
2. 接入 official `AppBridge`/`PostMessageTransport`，打通 input/result/`oncalltool`/teardown。
3. conformance fixture 覆盖官方 React/vanilla example Apps；社区 React wrapper 另行可替换评估。
4. 配额、安全 telemetry、tenant/agent/server allowlist 灰度，始终保留 runtime kill switch。

验收：恶意 origin/source/resource/method、HITL allow/deny、new-turn revoke、ACP EOF 和 env-absent baseline E2E 通过。

## 12. 测试与可观测性

### 12.1 Contract/Engine

- strict envelope/apps version；request 中出现 `mcpProtocolVersion` 必须失败。
- offer 与 ACP `rawInput` update 任意顺序汇合；duplicate offer 只 open 一次，duplicate input 不改变已选权威值，冲突 input fail closed。
- standard ACP input 与 raw `CallToolResult` 的 `_meta`、`structuredContent`、`isError`、future fields 分别 round-trip。
- token、raw server identity、Peri binding 不出现在 relay/log。
- process/session/turn/generation/TTL 任一 mismatch fail closed；late response 不复活 entry。

### 12.2 Official SDK conformance

- `AppBridge(null)` 自动完成 Apps version negotiation，Fenix 不手工注入 core MCP version。
- handler 在 connect 前注册；initialized 前后 input/result 顺序正确。
- iframe request ID 只存在于 AppBridge transport，不穿透 backend。
- `oncalltool` 返回 raw result；`isError: true` 仍是 MCP protocol-success result。
- unknown capability/method、oversized payload、abort/unmount/teardown 行为确定。

### 12.3 Security/fallback

- wrong source/origin、跨 frame/appHandle、stale Web auth、CSP/permission escalation 全部拒绝。
- raw HTML 只在 transient endpoint 与 sandbox 流动，不进入主 DOM/Yjs/snapshot。
- 非 Peri、flag off、offer absent、SDK mismatch 下普通 ACP output 与当前 baseline 一致。

只记录低基数、脱敏字段：agent implementation、phase、stable reason、latency/bytes bucket、active/pending gauge。禁止记录 token、handle、server/tool raw identity、HTML、arguments/result、ACP/App JSON-RPC ID。

## 13. 实施前必须冻结的决策

1. initial raw `CallToolResult` 是扩展 `open` response，还是使用单独 single-binding `bootstrapRef`；推荐前者，超限直接降级。标准 ACP `rawInput` 不新增 Peri 字段。
2. binding-offer 最终 method 名与 envelope version 迁移策略。
3. browser bootstrap 的 item/total bytes、App call concurrency、timeout/cancel budget。
4. sandbox 专用 origin、CSP allowlist 与 capability 首版集合。
5. 是否采用社区 `@mcp-ui/client`：必须先证明单一 `ext-apps` resolved version、安全策略可注入且 conformance tests 通过；否则直接用官方 `AppBridge`。

在这些决策和 fixtures 闭环前，不开始跨层实现。

## 14. 事实源

- Peri：`peri-acp-types/src/mcp_apps.rs`、`peri-acp/src/host/mcp_apps.rs`、`peri-middlewares/src/mcp/{apps.rs,apps_relay.rs,tool_bridge.rs}`。
- Fenix：`packages/acp-link/src/client/{acp-spawn-helper.ts,instance-manager.ts}`、`packages/acp-link/src/acp-dispatcher.ts`、`packages/plugin-sdk/src/engine-relay.ts`、`packages/chat-channel/src/channel/relay-event-handler.ts`。
- 官方 SDK：`@modelcontextprotocol/ext-apps@1.7.5` package exports/types、官方 `examples/basic-host` 与 Apps specification `2026-01-26`。
- 社区候选：`@mcp-ui/client@7.1.1` package exports/types；仅作 Host React convenience layer 评估。
