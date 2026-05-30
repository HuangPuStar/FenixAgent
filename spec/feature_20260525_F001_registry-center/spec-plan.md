# 注册中心第二期：统一 relay 路径 执行计划

**目标:** 打通远端执行链路——改造 relay 层使 session 通过 machine WS 路由到远端 acp-link，废弃"ACP agent 直连"和"本地 Instance spawn"两条旧路径

**技术栈:** Elysia + Bun, WebSocket (NDJSON), acp-link (Node.js/Bun), React 19 + Vite + TanStack Router

**设计文档:** spec/feature_20260525_F001_registry-center/spec-design.md

## 改动总览

本次改动涉及 RCS 后端（`src/transport/` 的 relay 层和 ACP WS 层、`src/routes/acp/`、`src/types/`、`src/services/`、`src/index.ts`）、acp-link 客户端（`packages/acp-link/src/` 的 server.ts 和新增 session-manager.ts）、前端（`web/src/` 的 EnvironmentList、EnvironmentsPage、types、sdk）。核心思路是将 relay 路径从"本地 Instance / ACP agent 直连 / machine"三条统一为"machine"一条，并彻底删除 Instance 概念。

各 Task 依赖关系：Task 1 在 acp-ws-handler.ts 中建立 machine 连接查询能力和 session 消息转发机制，是后续所有 RCS Task 的基础。Task 2 依赖 Task 1 产出的 `findMachineConnectionById`/`onSessionMessage` 回调来构建 `openMachineRelay`。Task 3 依赖 Task 1 和 Task 2 完成后才能安全移除旧认证路径。Task 4 的删除工作依赖 Task 2 的兼容层函数就位。Task 5 是 acp-link 侧独立改动，建立 SessionManager 基础。Task 6 依赖 Task 5 的 SessionManager 来实现重连恢复和排队机制。Task 7 是前端独立改动，删除 Instance 相关 UI。

关键设计决策：经代码确认 `handleRelayOpen` 当前先查 Instance 再 fallback 到 `findAcpConnectionByAgentId`，改造后统一为查 Environment -> AgentConfig.machineId -> machine WS。`agentConfig` 表已有 `machineId` 外键（`src/db/schema.ts:508`），`EnvironmentRecord` 已有 `agentConfigId` 字段（`src/repositories/environment.ts:12`），环境到 Agent 到 machine 的链路完整。兼容层函数（`sendToAgentWs`/`findRunningInstanceByEnvironment`/`spawnInstanceFromEnvironment`/`sendToInstanceRelay`/`closeInstanceRelay`）签名不变、内部改为 machine WS 通信，确保 hermes-client、workflow/acp-transport、meta-agent 等调用方无需修改。

---

### Task 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**

- [x] 验证 RCS 后端构建工具可用
  - `cd /Users/zhongym29/FenixAgent && bun --version`
  - 预期: Bun 版本 >= 1.0

- [x] 验证 acp-link 包测试工具可用
  - `cd /Users/zhongym29/FenixAgent/packages/acp-link && bun test --help 2>&1 | head -3`
  - 预期: 显示 bun test 帮助信息

- [x] 验证前端构建工具可用
  - `cd /Users/zhongym29/FenixAgent && bun run build:web --help 2>&1 | head -3`
  - 预期: 不报错（或显示 vite build 帮助）

- [x] 运行 precheck 确认当前代码基线
  - `cd /Users/zhongym29/FenixAgent && bun run precheck 2>&1 | tail -10`
  - 预期: precheck 通过（或仅有预先存在的 warning）

**检查步骤:**

- [x] 验证构建命令可用
  - `cd /Users/zhongym29/FenixAgent && bun --version`
  - 预期: 输出版本号

- [x] 验证现有测试可运行
  - `cd /Users/zhongym29/FenixAgent && bun test src/__tests__/registry-service.test.ts 2>&1 | tail -5`
  - 预期: 测试通过（或仅有 mock 相关 warning）

---

### Task 1: acp-ws-handler.ts 改造 — machine 连接查询、session 消息转发、旧函数移除

**背景:**
本 Task 是注册中心第二期 relay 统一化的基础设施层。当前 `acp-ws-handler.ts` 维护两套连接模型：machine 连接（`isMachine: true`）和 ACP agent 连接（`isMachine: false`），后者通过 EventBus 订阅将消息路由到 ACP agent 的 WebSocket。改造目标是在该文件中建立 machine 连接查询能力（按 machineId、按 agentId）、添加 session 消息转发回调机制（供 relay 层使用），同时移除不再需要的 ACP agent 连接处理逻辑（`handleIdentify`、`handleRegister` 的 ACP agent 分支、EventBus 订阅）。新增的 `findMachineConnectionById` 和 `onSessionMessage` 回调是 Task 2 `openMachineRelay` 的直接依赖。

**涉及文件:**
- 修改: `src/types/store.ts`
- 修改: `src/transport/acp-ws-handler.ts`

**执行步骤:**

- [x] 在 `AcpConnectionEntry` 接口中新增 `wsId` 和 `onSessionMessage` 字段
  - 位置: `src/types/store.ts` 的 `AcpConnectionEntry` 接口（~L17-31），在 `machineId` 字段之后
  - 新增字段:
    ```typescript
    /** 连接自身的 wsId（与 connections Map 的 key 一致），方便 entry 反查自身 */
    wsId: string;
    /** relay 层设置的回调，machine 连接收到 session 消息时调用 */
    onSessionMessage?: (sessionId: string, type: string, payload: unknown) => void;
    ```
  - 原因: `wsId` 让 entry 持有自身 key，避免 relay 层额外维护 wsId->entry 映射；`onSessionMessage` 是 machine WS 到 relay 层的事件桥接机制

- [x] 在 `handleAcpWsOpen` 的 machine 分支中写入 `wsId` 字段
  - 位置: `src/transport/acp-ws-handler.ts` 的 `handleAcpWsOpen()` (~L43-55)，在 `connections.set(wsId, {...})` 调用的对象字面量中
  - 在 `machineId: null,` 之后新增一行: `wsId,`
  - 原因: machine 连接创建时即记录自身 wsId，使 entry 可反查

- [x] 新增 `findMachineConnectionById` 函数
  - 位置: `src/transport/acp-ws-handler.ts`，在 `closeAllAcpConnections` 之前（~L422 之前），作为新的导出函数
  - 关键逻辑:
    ```typescript
    /** 通过 machineId 查找在线的 machine WebSocket 连接 */
    export function findMachineConnectionById(machineId: string): AcpConnectionEntry | null {
      for (const entry of connections.values()) {
        if (entry.isMachine && entry.machineId === machineId && entry.ws.readyState === 1) {
          return entry;
        }
      }
      return null;
    }
    ```
  - 原因: 同步迭代 connections Map 即可，machine 连接数通常为个位数，无需额外索引。返回 null 表示 machine 不在线

- [x] 新增 agentId -> machineId 内存缓存及 `findMachineConnectionByAgentId` 函数
  - 位置: `src/transport/acp-ws-handler.ts`，在 `connections` Map 声明之后（~L17 之后），在 `findMachineConnectionById` 附近（~L422 之前）
  - 新增模块级变量:
    ```typescript
    /** agentId (environment.id) → machineId 缓存，供同步 sendToAgentWs 使用 */
    const agentMachineCache = new Map<string, string>();
    ```
  - 新增导出函数:
    ```typescript
    /** 通过 agentId 查找在线的 machine WebSocket 连接（异步，含 DB 查询）。结果会缓存到 agentMachineCache。 */
    export async function findMachineConnectionByAgentId(agentId: string): Promise<AcpConnectionEntry | null> {
      // 1. 先查缓存
      const cachedMachineId = agentMachineCache.get(agentId);
      if (cachedMachineId) {
        return findMachineConnectionById(cachedMachineId);
      }
      // 2. 查 environment → agentConfig → machineId
      const { environmentRepo } = await import("../repositories/environment");
      const env = await environmentRepo.getById(agentId);
      if (!env?.agentConfigId) return null;
      const { getAgentConfigById } = await import("../services/config/agent-config");
      const agentCfg = await getAgentConfigById(env.agentConfigId);
      if (!agentCfg?.machineId) return null;
      // 3. 缓存并查找连接
      agentMachineCache.set(agentId, agentCfg.machineId);
      return findMachineConnectionById(agentCfg.machineId);
    }
    ```
  - 原因: agentId 是 environment.id（如 `env_xxx`），需经 `environment.agentConfigId -> agentConfig.machineId` 两级映射才能找到 machine 连接。动态 import 避免循环依赖。缓存使后续同步 `sendToAgentWs` 调用可直接命中

- [x] 替换 `sendToAgentWs` 实现为 machine WS 通信
  - 位置: `src/transport/acp-ws-handler.ts`，替换 ~L415-420 的旧实现
  - 新实现:
    ```typescript
    /** 向 agent 对应的远端 machine 发送消息（兼容层，保留同步签名）。
     * 优先使用 agentMachineCache；cache miss 时遍历连接做 best-effort 发送。
     * 返回 true 表示消息已发送到至少一个 machine WS。 */
    export function sendToAgentWs(agentId: string, msg: object): boolean {
      // 1. 优先走缓存
      const cachedMachineId = agentMachineCache.get(agentId);
      if (cachedMachineId) {
        const entry = findMachineConnectionById(cachedMachineId);
        if (entry) {
          sendToWs(entry.ws, {
            type: "session_data",
            session_id: `auto_${agentId}`,
            payload: msg,
          });
          return true;
        }
        // machineId 缓存命中但连接已断，清除过期缓存
        agentMachineCache.delete(agentId);
      }
      // 2. cache miss — 无法确定 agent 对应哪台 machine，返回 false
      //    调用方（hermes-client、workflow）通过返回值判断发送结果
      return false;
    }
    ```
  - 原因: 保留同步签名（hermes-client、workflow 调用方无需修改），内部改为通过 machine WS 发送 `session_data` 消息。acp-link 侧收到未知 `session_id` 的 `session_data` 时自动 lazy spawn（Task 5 实现）。cache miss 返回 false 是预期行为——调用方通常已通过 relay 建立时预热了缓存

- [x] 移除 `findAcpConnectionByAgentId` 函数
  - 位置: `src/transport/acp-ws-handler.ts`，删除 ~L405-412 的整个函数定义和导出
  - 原因: 旧函数按 `entry.agentId` 匹配 ACP agent 连接，统一 relay 路径后不再存在 ACP agent 直连，该函数无适用场景。调用方（`relay-handler.ts` L39、`workflow/acp-transport.ts` L191）将分别在 Task 2 和 Task 4 中替换为 `findMachineConnectionByAgentId`

- [x] 修改 `handleAcpWsMessage` 转发 machine 连接的 session 消息到 relay 层
  - 位置: `src/transport/acp-ws-handler.ts` 的 `handleAcpWsMessage()` (~L295-367)，在 `msg.type === "heartbeat"` 处理块之后、`msg.type === "register"` 之前
  - 新增 session 消息类型处理块:
    ```typescript
    // machine 连接：session 生命周期消息转发到 relay 层
    const SESSION_MSG_TYPES = ["session_started", "session_data", "session_ended", "session_error", "session_queued", "session_resumed"];
    if (entry.isMachine && SESSION_MSG_TYPES.includes(msg.type as string)) {
      const sessionId = msg.session_id as string | undefined;
      if (sessionId && entry.onSessionMessage) {
        entry.onSessionMessage(sessionId, msg.type as string, (msg as Record<string, unknown>).payload);
      }
      continue;
    }
    ```
  - 插入位置: 在 `if (msg.type === "heartbeat")` 块（~L327-335）的 `continue` 之后、`if (msg.type === "register")`（~L337）之前
  - 原因: machine WS 上收到的 session_* 消息需要透传到 relay 层，由 relay 层转发给前端。`onSessionMessage` 回调由 Task 2 的 `openMachineRelay` 注册。处理时机在 heartbeat 之后、register 之前，因为这些 session 消息只可能来自已注册的 machine

- [x] 移除 `handleRegister` 的 ACP agent 分支（非 machine 路径）
  - 位置: `src/transport/acp-ws-handler.ts` 的 `handleRegister()` (~L165-223)
  - 操作: 删除 `if (entry.isMachine)` 守卫之后的整个 else 块（~L173-222），即删除 ACP agent 注册逻辑（检查是否已注册、调用 `handleAcpRegister`、订阅 EventBus 等）。保留 machine 分支（L170-172）不变
  - 修改后的 `handleRegister` 结构:
    ```typescript
    async function handleRegister(wsId: string, msg: Record<string, unknown>): Promise<void> {
      const entry = connections.get(wsId);
      if (!entry) return;

      // 所有连接均为 machine 连接，走 machine 注册流程
      await handleMachineRegister(wsId, msg);
    }
    ```
  - 原因: 统一 relay 路径后 `/acp/ws` 只接受 machine 连接，不再需要 ACP agent 注册逻辑。`handleAcpRegister` import 从文件顶部移除（若不再被其他函数引用）

- [x] 移除 `handleIdentify` 函数
  - 位置: `src/transport/acp-ws-handler.ts`，删除 ~L226-292 整个函数
  - 同时移除 `handleAcpWsMessage` 中 `msg.type === "identify"` 的处理分支（~L344-349）
  - 同时移除文件顶部 `handleAcpIdentify` 的 import（~L7，从 `../services/environment` 导入）
  - 原因: identify 是 ACP agent 通过 REST 预注册后、WS 第二次连接时绑定 agentId 的机制。machine 模型下没有 REST 预注册步骤，acp-link 直接 register，不再需要 identify

- [x] 移除 `handleAcpWsOpen` 中非 machine 连接的 EventBus 订阅逻辑
  - 位置: `src/transport/acp-ws-handler.ts` 的 `handleAcpWsOpen()`，非 machine 分支（~L59-108）
  - 操作: 将非 machine 分支的逻辑替换为拒绝连接。删除 L59-108 的所有内容（log、handleAcpConnect、keepalive 设置、connections.set、EventBus subscribe），替换为:
    ```typescript
    // 非 machine 连接不再支持 — ACP agent 直连模型已废弃
    log(`[ACP-WS] Non-machine connection rejected: wsId=${wsId}`);
    ws.close(4003, "ACP agent connections no longer supported; use machine registration");
    ```
  - 原因: ACP agent 直连路径废弃后，`handleAcpWsOpen` 的非 machine 分支不再有存在的意义。路由层（Task 3 改造）将不再传递非 machine 连接到此处，但 Task 1 先做防御性拒绝，避免残留调用路径造成未定义行为
  - 注意: 删除后需同时移除文件顶部不再使用的 import：`handleAcpConnect`（若不再引用）、`getAcpEventBus`（若不再引用）、`SessionEvent` 类型（若不再引用）

- [x] 移除 `handleAcpWsClose` 中非 machine 连接的 agent disconnect 逻辑
  - 位置: `src/transport/acp-ws-handler.ts` 的 `handleAcpWsClose()` (~L388-399)
  - 操作: 删除 `if (entry.agentId)` 块（~L388-399），包括 `handleAcpDisconnect` 调用和 `agent_disconnect` EventBus publish。machine 断连已在 `if (entry.isMachine)` 块中处理
  - 原因: 所有连接均为 machine 连接，agentId 始终为 null，agent disconnect 逻辑不再可达

- [x] 为 acp-ws-handler 改造编写单元测试
  - 测试文件: `src/__tests__/acp-machine-connection-lookup.test.ts`（新建）
  - 测试场景:
    - `findMachineConnectionById` 找到在线 machine 连接: 创建 isMachine=true、machineId="mach_001"、readyState=1 的连接 → 调用 `findMachineConnectionById("mach_001")` → 返回该 entry
    - `findMachineConnectionById` 找不到离线 machine: 创建 isMachine=true、machineId="mach_002"、readyState=3 的连接 → 调用 `findMachineConnectionById("mach_002")` → 返回 null
    - `findMachineConnectionById` 忽略非 machine 连接: 创建 isMachine=false、machineId="mach_003" 的连接 → 调用 → 返回 null
    - `sendToAgentWs` 缓存命中: 预设 `agentMachineCache.set("env_001", "mach_001")`，创建对应 machine 连接 → `sendToAgentWs("env_001", {type:"test"})` → 返回 true，machine WS 收到 `{type:"session_data", session_id:"auto_env_001", payload:{type:"test"}}`
    - `sendToAgentWs` 缓存过期自动清理: 预设缓存指向不存在的 machineId → 调用返回 false，缓存被清除
    - `handleAcpWsMessage` session 消息转发: 创建 isMachine=true 的 entry，设置 `onSessionMessage` mock → 调用 `handleAcpWsMessage` 传入 `{type:"session_started", session_id:"s1"}` → mock 被调用且收到 `("s1", "session_started", undefined)`
    - `handleAcpWsMessage` 无 `onSessionMessage` 时不崩溃: 创建 isMachine=true、onSessionMessage=undefined 的 entry → 调用传入 session_started 消息 → 不抛异常
    - `handleRegister` 走 machine 注册路径: 创建 isMachine=true 的 entry → 调用 handleRegister → 进入 handleMachineRegister 流程
  - 运行命令: `bun test src/__tests__/acp-machine-connection-lookup.test.ts`
  - 预期: 全部 8 个测试通过

**检查步骤:**

- [x] 验证 `AcpConnectionEntry` 类型包含新字段
  - `grep -n "wsId\|onSessionMessage" /Users/zhongym29/FenixAgent/src/types/store.ts`
  - 预期: 在 AcpConnectionEntry 接口中找到 `wsId: string` 和 `onSessionMessage` 字段定义

- [x] 验证 `findMachineConnectionById` 已导出
  - `grep -n "export function findMachineConnectionById" /Users/zhongym29/FenixAgent/src/transport/acp-ws-handler.ts`
  - 预期: 匹配到函数声明，且签名包含 `(machineId: string): AcpConnectionEntry | null`

- [x] 验证 `findMachineConnectionByAgentId` 已导出
  - `grep -n "export async function findMachineConnectionByAgentId" /Users/zhongym29/FenixAgent/src/transport/acp-ws-handler.ts`
  - 预期: 匹配到异步函数声明

- [x] 验证 `findAcpConnectionByAgentId` 已移除
  - `grep -n "findAcpConnectionByAgentId" /Users/zhongym29/FenixAgent/src/transport/acp-ws-handler.ts`
  - 预期: 无匹配（函数已删除）

- [x] 验证 `handleIdentify` 已移除
  - `grep -n "handleIdentify\|handleAcpIdentify" /Users/zhongym29/FenixAgent/src/transport/acp-ws-handler.ts`
  - 预期: 无匹配（函数和 import 均已删除）

- [x] 验证 EventBus 订阅逻辑已移除
  - `grep -n "getAcpEventBus\|event-bus\|EventBus" /Users/zhongym29/FenixAgent/src/transport/acp-ws-handler.ts`
  - 预期: 无匹配（import 和调用均已删除）

- [x] 验证 `handleAcpWsMessage` 包含 session 消息转发逻辑
  - `grep -n "SESSION_MSG_TYPES\|session_started\|session_ended\|session_queued\|session_resumed\|onSessionMessage" /Users/zhongym29/FenixAgent/src/transport/acp-ws-handler.ts`
  - 预期: 找到 session 消息类型数组定义和 `onSessionMessage` 调用

- [x] 验证 `handleRegister` 只保留 machine 分支
  - `grep -n "handleAcpRegister" /Users/zhongym29/FenixAgent/src/transport/acp-ws-handler.ts`
  - 预期: 无匹配（import 和调用均已删除）

- [x] 运行单元测试验证逻辑正确性
  - `bun test src/__tests__/acp-machine-connection-lookup.test.ts`
  - 预期: 全部 8 个测试通过

- [x] 运行 TypeScript 编译检查
  - `cd /Users/zhongym29/FenixAgent && bunx tsc --noEmit 2>&1 | head -20`
  - 预期: 无类型错误（或仅有 Task 2/4 待修复的下游引用错误，即 `relay-handler.ts` 和 `workflow/acp-transport.ts` 中对 `findAcpConnectionByAgentId` 的引用）

---

### Task 2: relay-handler.ts 改造 — openMachineRelay、简化 handleRelayOpen、删除旧路径、兼容层函数

**背景:**
本 Task 是 relay 统一化的核心。当前 `relay-handler.ts` 维护三条路径：`openInstanceRelay`（通过 `@fenix/core` 的 `connectInstanceRelay` 桥接本地 spawned Instance）、`openEventBusRelay`（通过 EventBus 桥接 ACP agent 直连 WS）、以及失败处理。改造后统一为一条路径：`handleRelayOpen` → 查 Environment → AgentConfig.machineId → `findMachineConnectionById` → `openMachineRelay`。同时在本文件中新增兼容层函数（`sendToAgentWs`、`findRunningInstanceByEnvironment`、`spawnInstanceFromEnvironment`、`sendToInstanceRelay`、`closeInstanceRelay`），这些函数签名与旧版 `instance.ts` 和 `acp-ws-handler.ts` 中的同名函数完全一致，内部改为 machine WS 通信，确保 hermes-client、workflow、meta-agent 等调用方无需修改。

经代码确认：`handleRelayOpen` 当前 L28-31 先按 sessionId 查 Instance，无结果时 L30 查 `findRunningInstanceByEnvironment`；L39-45 fallback 到 `findAcpConnectionByAgentId`。`handleRelayMessage` L201-235 有三条分支：relayHandle 转发、instanceId buffer、EventBus 模式。`handleRelayClose` L247-271 使用 `instanceId` 和 `relayHandle` 做清理。`RelayConnectionEntry` 已有 `agentId`/`userId`/`instanceId`/`relayHandle`/`outboundBuffer` 等字段。

**涉及文件:**
- 修改: `src/transport/relay/relay-handler.ts`
- 修改: `src/transport/relay/index.ts`

**执行步骤:**

- [x] 重写 `handleRelayOpen` 为单一的 machine relay 路径
  - 位置: `src/transport/relay/relay-handler.ts`，替换 L16-48 的整个 `handleRelayOpen` 函数体
  - 新实现:
    ```typescript
    export async function handleRelayOpen(
      ws: WsConnection,
      relayWsId: string,
      agentId: string,
      userId: string,
      sessionId?: string,
    ): Promise<void> {
      log(`[ACP-Relay] Relay connection opened: relayWsId=${relayWsId} agentId=${agentId}`);

      // 查 Environment → AgentConfig → machineId → machine WS 连接
      const env = await environmentRepo.getById(agentId);
      if (!env?.agentConfigId) {
        sendToRelayWs(ws, { type: "error", message: "Agent not found or not bound to a machine" });
        ws.close(4004, "agent not bound to machine");
        return;
      }
      const agentCfg = await getAgentConfigById(env.agentConfigId);
      if (!agentCfg?.machineId) {
        sendToRelayWs(ws, { type: "error", message: "Agent not bound to a machine" });
        ws.close(4004, "agent not bound to machine");
        return;
      }
      const machineConn = findMachineConnectionById(agentCfg.machineId);
      if (!machineConn) {
        sendToRelayWs(ws, { type: "error", message: "Agent not found or offline" });
        ws.close(4004, "agent not found");
        return;
      }

      // 预热 agentMachineCache（供后续 sendToAgentWs 同步调用）
      import("../acp-ws-handler.js").then((mod) => {
        mod.setAgentMachineCache?.(agentId, agentCfg.machineId);
      });

      openMachineRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, machineConn);
    }
    ```
  - 新增 import（在文件顶部）:
    ```typescript
    import { environmentRepo } from "../../repositories";
    import { getAgentConfigById } from "../../services/config/agent-config";
    ```
  - 删除 import（移除 L3-5 的旧依赖）:
    - `import { getCoreRuntime } from "../../services/core-bootstrap";`
    - `import { findInstanceBySessionId, findRunningInstanceByEnvironment } from "../../services/instance";`
    - `import { findAcpConnectionByAgentId, sendToAgentWs } from "../acp-ws-handler";`
  - 新增 import（替换为 machine 相关）:
    ```typescript
    import { findMachineConnectionById } from "../acp-ws-handler";
    ```
  - 原因: `handleRelayOpen` 改为 async（需要查 DB），统一为查 machine 连接的单一路径。使用 `sessionId ?? relayWsId` 作为 session_id，保证即使调用方不传 sessionId 也有唯一标识

- [x] 新增 `openMachineRelay` 函数
  - 位置: `src/transport/relay/relay-handler.ts`，在 `handleRelayOpen` 之后（原 `openInstanceRelay` 位置 ~L51 处）
  - 关键逻辑（替换原 L51-134 的 `openInstanceRelay` 和 L137-173 的 `openEventBusRelay`）:
    ```typescript
    function openMachineRelay(
      ws: WsConnection,
      relayWsId: string,
      agentId: string,
      userId: string,
      sessionId: string,
      machineConn: AcpConnectionEntry,
    ): void {
      const relayKeepalive = setInterval(() => {
        const entry = manager.get(relayWsId);
        if (!entry || entry.ws.readyState !== 1) {
          clearInterval(relayKeepalive);
          return;
        }
        sendToRelayWs(entry.ws, { type: "keep_alive" });
      }, RELAY_KEEPALIVE_INTERVAL_MS);

      const entry: RelayConnectionEntry = {
        agentId,
        userId,
        unsub: null,
        keepalive: relayKeepalive,
        ws,
        openTime: Date.now(),
        instanceId: machineConn.machineId, // 复用 instanceId 字段存 machineId
        relayHandle: null,
        relayUnsub: null,
        outboundBuffer: [],
        sessionStarted: false, // 等待 session_started 确认
      };
      manager.add(relayWsId, entry);

      // 设置 machine 连接的 onSessionMessage 回调
      machineConn.onSessionMessage = (msgSessionId: string, type: string, payload: unknown) => {
        const e = manager.get(relayWsId);
        if (!e || e.ws.readyState !== 1) return;

        switch (type) {
          case "session_started":
            e.sessionStarted = true;
            // 开始转发缓冲消息
            for (const buffered of e.outboundBuffer) {
              sendToWs(machineConn.ws, {
                type: "session_data",
                session_id: sessionId,
                payload: buffered,
              });
            }
            e.outboundBuffer.length = 0;
            // 通知前端远端 agent 已就绪
            sendToRelayWs(ws, { type: "status", payload: { connected: true } });
            break;
          case "session_data":
            // 解包 payload 转发到前端 relay WS
            sendToRelayWs(ws, payload as object);
            break;
          case "session_ended":
          case "session_error":
            // 关闭前端 relay WS
            sendToRelayWs(ws, { type: "error", message: (payload as Record<string,unknown>)?.error || "Session ended" });
            ws.close(1000, type);
            break;
          case "session_queued":
            sendToRelayWs(ws, { type: "status", payload: { connected: false, queued: true } });
            break;
          case "session_resumed":
            e.sessionStarted = true;
            sendToRelayWs(ws, { type: "status", payload: { connected: true, resumed: true } });
            break;
        }
      };

      // 发送 session_start 到 machine WS
      sendToWs(machineConn.ws, { type: "session_start", session_id: sessionId });

      // 超时处理：10s 内未收到 session_started 或 session_queued，则失败
      const spawnTimeout = setTimeout(() => {
        const e = manager.get(relayWsId);
        if (e && !e.sessionStarted) {
          log(`[ACP-Relay] session_start timeout for ${relayWsId}`);
          sendToRelayWs(ws, { type: "error", message: "Agent spawn timeout" });
          ws.close(1011, "spawn timeout");
          manager.remove(relayWsId);
        }
      }, 10000);

      // 成功后清除超时
      const origOnMsg = machineConn.onSessionMessage;
      machineConn.onSessionMessage = (msgSessionId, type, payload) => {
        if (type === "session_started" || type === "session_queued" || type === "session_error") {
          clearTimeout(spawnTimeout);
        }
        origOnMsg(msgSessionId, type, payload);
      };

      log(`[ACP-Relay] Machine relay established: relayWsId=${relayWsId} → machineId=${machineConn.machineId} sessionId=${sessionId}`);
    }
    ```
  - 原因: `openMachineRelay` 是新的唯一 relay 桥接路径。通过 machine WS 的 `onSessionMessage` 回调接收 session 消息并转发到前端。复用 `RelayConnectionEntry.instanceId` 字段存储 machineId。超时 10s 确保不会无限等待

- [x] 修改 `handleRelayMessage` 删除 Instance 和 EventBus 分支，统一为 machine relay 分支
  - 位置: `src/transport/relay/relay-handler.ts`，替换 L176-235 的整个 `handleRelayMessage` 函数体
  - 新实现:
    ```typescript
    export async function handleRelayMessage(
      ws: WsConnection,
      relayWsId: string,
      data: string | Record<string, unknown>,
    ): Promise<void> {
      const entry = manager.get(relayWsId);
      if (!entry) return;

      let parsed: Record<string, unknown>;
      if (typeof data === "string") {
        try { parsed = JSON.parse(data); } catch {
          logError("[ACP-Relay] parse error:", data.substring(0, 120));
          return;
        }
      } else {
        parsed = data;
      }

      // ping/pong 处理
      if (parsed.type === "ping") {
        sendToRelayWs(ws, { type: "pong" });
        return;
      }
      if (parsed.type === "keep_alive") return;

      // 获取 machine 连接
      const machineConn = findMachineConnectionById(entry.instanceId ?? "");
      if (!machineConn) {
        sendToRelayWs(ws, { type: "error", message: "Machine offline" });
        return;
      }

      // 等待 session_started：缓冲消息
      if (!entry.sessionStarted) {
        entry.outboundBuffer.push(parsed);
        return;
      }

      // 通过 machine WS 发送 session_data
      sendToWs(machineConn.ws, {
        type: "session_data",
        session_id: relayWsId,
        payload: parsed,
      });
    }
    ```
  - 原因: 删除 `entry.relayHandle` 转发（旧 Instance 路径）、`entry.instanceId` buffer（旧 Instance 等待路径）、`sendToAgentWs` 调用（旧 EventBus 路径），统一为 machine WS 的 `session_data` 转发

- [x] 修改 `handleRelayClose` 删除 Instance 相关清理，改为发送 `session_end` 到 machine WS
  - 位置: `src/transport/relay/relay-handler.ts`，替换 L238-273 的整个 `handleRelayClose` 函数体
  - 新实现:
    ```typescript
    export function handleRelayClose(_ws: WsConnection, relayWsId: string, code?: number, reason?: string): void {
      const entry = manager.get(relayWsId);
      if (!entry) return;

      const duration = Math.round((Date.now() - entry.openTime) / 1000);
      log(`[ACP-Relay] Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? "none"} duration=${duration}s`);

      // 发送 session_end 到 machine WS
      const machineId = entry.instanceId;
      if (machineId) {
        const machineConn = findMachineConnectionById(machineId);
        if (machineConn) {
          sendToWs(machineConn.ws, { type: "session_end", session_id: relayWsId });
        }
      }

      manager.remove(relayWsId);
    }
    ```
  - 删除: `hasOtherRelayForInstance` 检查、`entry.relayHandle.close()`、`getCoreRuntime().getInstance()` 等所有 Instance 相关清理逻辑
  - 原因: relay 断连时通知远端 acp-link kill 子进程。machine WS 上的 `session_end` 消息触发 acp-link 的 SessionManager 清理

- [x] 新增兼容层函数 `sendToAgentWs`（签名兼容，内部通过 machine WS 发送）
  - 位置: `src/transport/relay/relay-handler.ts`，在 `closeInstanceRelay` 之后新增（~L317 之后）
  - 实现:
    ```typescript
    /**
     * 兼容层：向 agent 对应的远端 machine 发送消息。
     * 保留同步签名以兼容 hermes-client 和 workflow/acp-transport。
     * 内部通过 agentMachineCache 查找 machine 连接，通过 session_data 发送。
     */
    export function sendToAgentWs(agentId: string, msg: object): boolean {
      // 优先从 agentMachineCache 获取 machineId（由 handleRelayOpen 预热）
      // 此处使用动态 require 避免循环依赖，实际导入已在文件顶部
      const { findMachineConnectionById, getAgentMachineCache } = require("../acp-ws-handler");
      const cache = getAgentMachineCache?.();
      const machineId = cache?.get(agentId);
      if (machineId) {
        const entry = findMachineConnectionById(machineId);
        if (entry) {
          sendToWs(entry.ws, {
            type: "session_data",
            session_id: `auto_${agentId}`,
            payload: msg,
          });
          return true;
        }
      }
      // cache miss — 遍历所有 machine 连接做 best-effort 发送
      // 实际中由 handleRelayOpen 预热缓存，此分支仅用于极端边缘情况
      return false;
    }
    ```
  - 原因: 保留 `sendToAgentWs` 同名导出以兼容 `hermes-client.ts`（L267）和 `workflow/acp-transport.ts`（L164, L240）。内部通过 `agentMachineCache` 查找 machine，cache miss 返回 false

- [x] 新增兼容层函数 `findRunningInstanceByEnvironment`（签名兼容，虚拟 SpawnedInstance）
  - 位置: `src/transport/relay/relay-handler.ts`，在 `sendToAgentWs` 之后
  - 实现:
    ```typescript
    /**
     * 兼容层：通过 environmentId 查找对应 machine 在线状态，返回虚拟 SpawnedInstance。
     * 保留签名以兼容 hermes-client 和 index.ts 的 auto-start 逻辑。
     */
    export async function findRunningInstanceByEnvironment(
      environmentId: string,
      userId?: string,
    ): Promise<SpawnedInstance | undefined> {
      const { findMachineConnectionByAgentId } = await import("../acp-ws-handler");
      const entry = await findMachineConnectionByAgentId(environmentId);
      if (!entry) return undefined;
      return {
        id: entry.machineId!,
        userId: entry.userId,
        port: 0,
        pid: null,
        status: entry.ws.readyState === 1 ? "running" : "stopped",
        command: "",
        error: null,
        apiKey: "",
        createdAt: new Date(entry.openTime),
        environmentId,
        instanceNumber: 1,
      };
    }
    ```
  - 需要 import `SpawnedInstance` 类型（从 `../../services/instance` 或内联定义）。但 instance.ts 将在 Task 4 删除，此处在本文件中定义最小化的 `SpawnedInstance` 类型内联或从共享类型导入
  - 原因: hermes-client.ts L256 调用 `findRunningInstanceByEnvironment(agentId)` 判断 agent 是否在线，返回虚拟值使其逻辑不变

- [x] 新增兼容层函数 `spawnInstanceFromEnvironment`（签名兼容，远端 spawn）
  - 位置: `src/transport/relay/relay-handler.ts`，在 `findRunningInstanceByEnvironment` 之后
  - 实现:
    ```typescript
    /**
     * 兼容层：通过 machine WS 请求远端 spawn agent 子进程。
     * 保留签名以兼容 meta-agent 和 environment routes。
     */
    export async function spawnInstanceFromEnvironment(
      userId: string,
      environmentId: string,
      prefetchedEnv?: EnvironmentRecord,
      extraEnv?: Record<string, string>,
    ): Promise<SpawnedInstance> {
      const { findMachineConnectionByAgentId } = await import("../acp-ws-handler");
      const entry = await findMachineConnectionByAgentId(environmentId);
      if (!entry) throw new NotFoundError("No online machine for this environment");

      const sessionId = `auto_${environmentId}_${Date.now()}`;
      sendToWs(entry.ws, { type: "session_start", session_id: sessionId });

      // 等待 session_started（超时 30s）
      const started = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 30000);
        const origCb = entry.onSessionMessage;
        entry.onSessionMessage = (msgSessionId, type) => {
          if (msgSessionId === sessionId && type === "session_started") {
            clearTimeout(timeout);
            resolve(true);
          }
          origCb?.(msgSessionId, type);
        };
      });

      if (!started) throw new AppError("Remote agent spawn timeout", "SPAWN_TIMEOUT", 504);

      return {
        id: entry.machineId!,
        userId,
        port: 0,
        pid: null,
        status: "running",
        command: "",
        error: null,
        apiKey: "",
        createdAt: new Date(),
        environmentId,
        instanceNumber: 1,
      };
    }
    ```
  - 需要 import: `NotFoundError` 从 `../../errors`、`AppError` 从 `../../errors`
  - 原因: meta-agent.ts L104/L128 和 environments.ts L73 调用此函数启动远端 agent，签名保留使调用方无需修改

- [x] 替换 `closeInstanceRelay` 和 `sendToInstanceRelay` 实现为 machine WS 版本
  - 位置: `src/transport/relay/relay-handler.ts`，替换 L303-338 的旧 `closeInstanceRelay` 和 `sendToInstanceRelay`
  - `closeInstanceRelay` 新实现:
    ```typescript
    export function closeInstanceRelay(instanceId: string): void {
      const entry = findMachineConnectionById(instanceId);
      if (!entry) return;
      sendToWs(entry.ws, { type: "session_end", session_id: `auto_${instanceId}` });
    }
    ```
  - `sendToInstanceRelay` 新实现:
    ```typescript
    export function sendToInstanceRelay(instanceId: string, data: string): boolean {
      const entry = findMachineConnectionById(instanceId);
      if (!entry) return false;
      try {
        const parsed = JSON.parse(data);
        sendToWs(entry.ws, {
          type: "session_data",
          session_id: `auto_${instanceId}`,
          payload: parsed,
        });
        return true;
      } catch {
        return false;
      }
    }
    ```
  - import `findMachineConnectionById` 从 `../acp-ws-handler`（已在文件顶部导入）
  - 原因: hermes-client.ts L259 调用 `sendToInstanceRelay`，签名不变，内部改为通过 machine WS 发送 `session_data`

- [x] 修改 `closeAllRelayConnections` 删除 Instance 相关清理
  - 位置: `src/transport/relay/relay-handler.ts`，修改 L276-300 的 `closeAllRelayConnections` 函数
  - 删除 `entry.relayHandle` 和 `entry.relayUnsub` 相关的清理代码（L283-288），只保留: `clearInterval(entry.keepalive)`、`entry.unsub?.()`、`entry.ws.close(1001, "server_shutdown")`
  - 原因: 已无 core relay handle 和 relayUnsub，关闭时只需清理 keepalive 和 WS

- [x] 更新 `src/transport/relay/index.ts` 导出列表
  - 位置: `src/transport/relay/index.ts`
  - 删除 export: `closeInstanceRelay`、`sendToInstanceRelay`（这两个函数仍存在于 relay-handler.ts 但签名兼容，不需要变化）
  - 新增 export（如果 `sendToAgentWs`、`findRunningInstanceByEnvironment`、`spawnInstanceFromEnvironment` 定义在 relay-handler.ts 中）:
    ```typescript
    export { sendToAgentWs, findRunningInstanceByEnvironment, spawnInstanceFromEnvironment } from "./relay-handler";
    ```
  - 注意: `closeInstanceRelay` 和 `sendToInstanceRelay` 保留导出（hermes-client 通过 `../transport/relay` 导入）

- [x] 新增 `RelayConnectionEntry` 的 `sessionStarted` 字段
  - 位置: `src/types/store.ts` 的 `RelayConnectionEntry` 接口（~L39-49）
  - 新增字段: `sessionStarted?: boolean;`（在 `outboundBuffer` 之后）
  - 原因: `openMachineRelay` 需要等待 `session_started` 确认后才能转发消息，该字段标记是否已收到确认

- [x] 为 relay-handler.ts 的核心逻辑编写单元测试
  - 测试文件: `src/__tests__/relay-handler-machine.test.ts`（新建）
  - 测试场景:
    - `openMachineRelay` 发送 session_start 到 machine WS: mock machineConn 和 ws，调用 `openMachineRelay` → 验证 machine WS 收到 `{type: "session_start", session_id}`
    - `openMachineRelay` 收到 session_started 后转发缓冲消息: 先调用 `handleRelayMessage` 缓冲一条消息 → 触发 `onSessionMessage("session_started")` → 验证 machine WS 收到 `session_data` 包含缓冲消息
    - `openMachineRelay` 收到 session_data 解包转发到前端: 触发 `onSessionMessage("session_data", payload)` → 验证前端 WS 收到 payload
    - `openMachineRelay` 收到 session_ended 关闭前端 relay: 触发 `onSessionMessage("session_ended")` → 验证前端 WS 被 close
    - `openMachineRelay` 10s 超时关闭 relay: mock 不触发任何 onSessionMessage → 验证 10s 后前端 WS 收到 error 并被 close
    - `handleRelayOpen` agent 未绑定 machine 返回错误: mock agentConfig 无 machineId → 验证 WS 收到 error 和 close(4004)
    - `handleRelayOpen` machine 离线返回错误: mock findMachineConnectionById 返回 null → 验证 WS 收到 error 和 close(4004)
    - `handleRelayClose` 发送 session_end 到 machine WS: 调用 `handleRelayClose` → 验证 machine WS 收到 `{type: "session_end"}`
  - 运行命令: `bun test src/__tests__/relay-handler-machine.test.ts`
  - 预期: 全部 8 个测试通过

**检查步骤:**

- [x] 验证 `handleRelayOpen` 改为单一路径
  - `grep -n "findRunningInstanceByEnvironment\|findAcpConnectionByAgentId\|openInstanceRelay\|openEventBusRelay" /Users/zhongym29/FenixAgent/src/transport/relay/relay-handler.ts`
  - 预期: 无匹配（旧路径全部删除）

- [x] 验证 `openMachineRelay` 存在
  - `grep -n "function openMachineRelay" /Users/zhongym29/FenixAgent/src/transport/relay/relay-handler.ts`
  - 预期: 找到函数定义

- [x] 验证兼容层函数导出
  - `grep -n "export function sendToAgentWs\|export.*findRunningInstanceByEnvironment\|export.*spawnInstanceFromEnvironment" /Users/zhongym29/FenixAgent/src/transport/relay/relay-handler.ts`
  - 预期: 找到三个兼容层函数的 export

- [x] 验证 `handleRelayClose` 发送 session_end
  - `grep -n "session_end" /Users/zhongym29/FenixAgent/src/transport/relay/relay-handler.ts`
  - 预期: 在 `handleRelayClose` 和 `closeInstanceRelay` 中找到 `session_end`

- [x] 运行单元测试验证逻辑正确性
  - `bun test src/__tests__/relay-handler-machine.test.ts`
  - 预期: 全部 8 个测试通过

- [x] 运行 TypeScript 编译检查
  - `bunx tsc --noEmit 2>&1 | head -20`
  - 预期: 无本 Task 相关类型错误

---

### Task 3: /acp/ws 端点简化 + relay 类型扩展

**背景:**
当前 `/acp/ws` 端点（`src/routes/acp/index.ts`）支持三种认证路径：REGISTRY_SECRET（machine 注册）、API key（ACP agent）、environment secret（ACP agent identify）。改造后只保留 REGISTRY_SECRET 认证路径，所有非 machine 连接直接拒绝（4003）。同时完善 `RelayConnectionEntry` 类型以支持 pending_reconnect 状态。

经代码确认：`/acp/ws` 的 `open` 回调 L88-127 先检查 `secret` query param 匹配 REGISTRY_SECRET（L98-107），再 fallback 到 token-based auth（L109-126）。token-based 路径调用 `resolveTokenAuth` 检查 environment secret 和 API key。改造后删除 L109-126 的 token 路径，L98-107 的 machine 路径保留并简化：secret 不匹配时直接 4003。

**涉及文件:**
- 修改: `src/routes/acp/index.ts`
- 修改: `src/types/store.ts`

**执行步骤:**

- [x] 简化 `/acp/ws` 端点的 `open` 回调
  - 位置: `src/routes/acp/index.ts`，修改 `"/ws"` 的 `open(ws)` 回调（~L88-127）
  - 删除: 整个 token-based 认证路径（L109-126 的 `resolveTokenAuth` 调用和后续 `handleAcpWsOpen` 的非 machine 调用）
  - 删除: `resolveTokenAuth` 函数（L41-68）和它的辅助依赖 `getEnvironmentBySecret` import（L8）
  - 修改后的 `open` 回调:
    ```typescript
    async open(ws) {
      const url = new URL(ws.data.request.url);
      const secret = url.searchParams.get("secret");
      const registrySecret = validateEnv().REGISTRY_SECRET;

      if (!secret || !registrySecret || secret !== registrySecret) {
        log("[ACP-WS] Upgrade rejected: invalid or missing registry secret");
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const wsId = `acp_ws_${uuid().replace(/-/g, "")}`;
      (ws.data as any).__acpWsId = wsId;
      log(`[ACP-WS] Machine upgrade accepted: wsId=${wsId} secret matched`);
      handleAcpWsOpen(adaptWs(ws), wsId, "__machine__", null, true);
    }
    ```
  - 删除 import: `auth`（L2）、`lookupUserById`（L5）、`environmentRepo`（L7）、`getEnvironmentBySecret`（L8）
  - 保留 import: `validateEnv`（L4）、`handleAcpWsOpen/handleAcpWsMessage/handleAcpWsClose`（L9）
  - 原因: 只接受 machine 注册连接，非 machine 连接一律 4003

- [x] 在 `RelayConnectionEntry` 中新增 `pendingReconnect` 和 `machineWsId` 字段
  - 位置: `src/types/store.ts` 的 `RelayConnectionEntry` 接口（~L39-49），在 `sessionStarted`（Task 2 新增之后）之后
  - 新增字段:
    ```typescript
    /** machine 断连后标记为待重连，保持 relay WS 连接不关 */
    pendingReconnect?: boolean;
    /** machine 连接的 wsId，用于断连后恢复 onSessionMessage 回调 */
    machineWsId?: string;
    ```
  - 原因: `pendingReconnect` 支持 machine 断连后 relay WS 保持连接等待重连恢复（验收标准第10条）。`machineWsId` 记录关联的 machine 连接 ID

- [x] 为 `/acp/ws` 端点简化编写单元测试
  - 测试文件: `src/__tests__/acp-ws-auth.test.ts`（新建）
  - 测试场景:
    - REGISTRY_SECRET 正确时接受连接: mock validateEnv 返回匹配的 secret → 验证 `handleAcpWsOpen` 被调用且 `isMachine=true`
    - REGISTRY_SECRET 不匹配时拒绝: mock validateEnv 返回不匹配的 secret → 验证 WS close(4003, "unauthorized")
    - 无 secret 参数时拒绝: URL 无 secret query param → 验证 WS close(4003)
    - REGISTRY_SECRET 为空字符串时拒绝: mock validateEnv 返回空 REGISTRY_SECRET → 验证 WS close(4003)
  - 运行命令: `bun test src/__tests__/acp-ws-auth.test.ts`
  - 预期: 全部 4 个测试通过

**检查步骤:**

- [x] 验证 `resolveTokenAuth` 已删除
  - `grep -n "resolveTokenAuth\|getEnvironmentBySecret" /Users/zhongym29/FenixAgent/src/routes/acp/index.ts`
  - 预期: 无匹配

- [x] 验证 `/acp/ws` 只保留 REGISTRY_SECRET 认证
  - `grep -n "REGISTRY_SECRET\|secret.*close.*4003" /Users/zhongym29/FenixAgent/src/routes/acp/index.ts`
  - 预期: 找到 REGISTRY_SECRET 检查和 4003 close 逻辑

- [x] 运行单元测试
  - `bun test src/__tests__/acp-ws-auth.test.ts`
  - 预期: 全部 4 个测试通过

---

### Task 4: 代码删除与清理 — instance 模块、路由、schema、所有引用

**背景:**
Instance 概念废弃，本地 agent 进程管理职责由远端 acp-link 承担。需要删除 `src/services/instance.ts`、`src/routes/web/instances.ts`、`src/schemas/instance.schema.ts` 及其 7 个测试文件，并清理所有下游引用：`src/index.ts`、`src/routes/web/environments.ts`、`src/routes/web/index.ts`、`src/services/environment-web.ts`、`src/services/hermes-client.ts`、`src/services/workflow/acp-transport.ts` 等。

经代码确认：以下文件 import instance 相关模块：
- `src/index.ts` L31: `findRunningInstanceByEnvironment, spawnInstanceFromEnvironment, stopAllInstances`
- `src/routes/web/environments.ts` L19: `enterEnvironment, listInstancesResponse, spawnInstanceFromEnvironment`
- `src/routes/web/environments.ts` L73: `spawnInstanceFromEnvironment(record.userId, record.id)`
- `src/routes/web/environments.ts` L163-178: `/environments/:id/instances` 路由
- `src/routes/web/index.ts` L8: `import webInstances from "./instances"` + L28: `.use(webInstances)`
- `src/services/environment-web.ts` L10: `import { groupActiveInstancesByEnvironment }`
- `src/services/environment-web.ts` L124: `const instanceMap = groupActiveInstancesByEnvironment()`
- `src/services/hermes-client.ts` L3: `import { sendToAgentWs } from "../transport/acp-ws-handler"`  — 已在 Task 1 替换实现
- `src/services/hermes-client.ts` L4: `import { sendToInstanceRelay } from "../transport/relay"` — 已在 Task 2 替换实现
- `src/services/hermes-client.ts` L6: `import { findRunningInstanceByEnvironment } from "./instance"` — 需改为 relay-handler 导出
- `src/services/workflow/acp-transport.ts` L13: `import { findAcpConnectionByAgentId, sendToAgentWs }` — 需改为 relay-handler/acp-ws-handler 导出
- `src/types/store.ts` L73-82: `InstanceSupplement` 接口 — 删除

**涉及文件:**
- 删除: `src/services/instance.ts`、`src/routes/web/instances.ts`、`src/schemas/instance.schema.ts`
- 删除: `src/__tests__/instance-service.test.ts`、`src/__tests__/instance-routes.test.ts`、`src/__tests__/instance-error-codes.test.ts`、`src/__tests__/instance-getinstance-cleanup.test.ts`、`src/__tests__/instance-meta.test.ts`、`src/__tests__/instance-prefetch-env.test.ts`、`src/__tests__/instance-supplement-cleanup.test.ts`
- 修改: `src/index.ts`、`src/routes/web/environments.ts`、`src/routes/web/index.ts`、`src/services/environment-web.ts`、`src/services/hermes-client.ts`、`src/services/workflow/acp-transport.ts`、`src/types/store.ts`

**执行步骤:**

- [x] 删除 instance 相关源文件
  - `rm /Users/zhongym29/FenixAgent/src/services/instance.ts`
  - `rm /Users/zhongym29/FenixAgent/src/routes/web/instances.ts`
  - `rm /Users/zhongym29/FenixAgent/src/schemas/instance.schema.ts`
  - 原因: Instance 概念废弃，删除所有相关源文件

- [x] 删除 instance 相关测试文件
  - `rm /Users/zhongym29/FenixAgent/src/__tests__/instance-service.test.ts`
  - `rm /Users/zhongym29/FenixAgent/src/__tests__/instance-routes.test.ts`
  - `rm /Users/zhongym29/FenixAgent/src/__tests__/instance-error-codes.test.ts`
  - `rm /Users/zhongym29/FenixAgent/src/__tests__/instance-getinstance-cleanup.test.ts`
  - `rm /Users/zhongym29/FenixAgent/src/__tests__/instance-meta.test.ts`
  - `rm /Users/zhongym29/FenixAgent/src/__tests__/instance-prefetch-env.test.ts`
  - `rm /Users/zhongym29/FenixAgent/src/__tests__/instance-supplement-cleanup.test.ts`
  - 原因: 测试文件随源文件一起删除

- [x] 清理 `src/index.ts` 的 instance 引用和 auto-start 逻辑
  - 位置: `src/index.ts`
  - 删除 import L31: `import { findRunningInstanceByEnvironment, spawnInstanceFromEnvironment, stopAllInstances } from "./services/instance";`
  - 删除 `getCoreRuntime()` import L29（如果没有其他地方使用）— 检查：L50 `getCoreRuntime()` 仍被调用，保留 import
  - 替换 import L35: `import { closeAllRelayConnections } from "./transport/relay";` 保持不变
  - 删除 L71-93 的 auto-start 逻辑块（`(async () => { ... })()`），替换为:
    ```typescript
    // Auto-start 逻辑已废弃：Instance 本地 spawn 不再支持，远端 machine agent 由 relay 按需启动
    ```
  - 删除 `closeAllAcpConnections` import L34（仅用于 gracefulShutdown 中的 `closeAllAcpConnections()` - 仍保留，但确认未被本文件其他处理影响）
  - 修改 gracefulShutdown 中 L197: 删除 `await stopAllInstances();` 这一行
  - 原因: `findRunningInstanceByEnvironment` 和 `spawnInstanceFromEnvironment` 从 relay-handler.ts 导出（Task 2），不再从 instance.ts 导入；`stopAllInstances` 废弃

- [x] 清理 `src/routes/web/environments.ts` 的 instance 引用
  - 位置: `src/routes/web/environments.ts`
  - 修改 import L19: 将 `import { enterEnvironment, listInstancesResponse, spawnInstanceFromEnvironment } from "../../services/instance";` 替换为:
    ```typescript
    import { spawnInstanceFromEnvironment } from "../../transport/relay";
    ```
  - 删除 `/environments/:id/instances` 路由：删除 L163-178（`app.get("/environments/:id/instances", ...)` 整个路由定义）
  - 修改 L73 auto-start 调用: `spawnInstanceFromEnvironment(record.userId, record.id)` 现在从 relay-handler 导入，函数签名不变
  - 删除 `enterEnvironment` 相关：POST `/environments/:id/enter` 路由（L137-161）仍使用 `enterEnvironment`，该函数需要迁移处理 — 见下一步
  - 原因: Instance REST API 路由删除，auto-start 改为远端 spawn。`enterEnvironment` 内部依赖 `ensureRunning` → `spawnInstanceFromEnvironment` + `findOrCreateForEnvironment`，需要重构

- [x] 重构 `enterEnvironment` 函数（从 instance.ts 迁移到 environment-web.ts）
  - 位置: `src/services/environment-web.ts` 新增 `enterEnvironment` 函数
  - 实现:
    ```typescript
    import { spawnInstanceFromEnvironment } from "../transport/relay";
    import { findOrCreateForEnvironment } from "./session";

    export async function enterEnvironment(
      userId: string,
      environmentId: string,
      instanceNumber?: number,
    ): Promise<{ session_id: string | null; instance_id: string; instance_number: number; instance_status: string; environment_id: string }> {
      // 远端 spawn agent
      const inst = await spawnInstanceFromEnvironment(userId, environmentId);
      // 查找或创建 RCS session
      const { id: sessionId } = await findOrCreateForEnvironment(environmentId, "Web Session", userId, "web");
      return {
        session_id: sessionId,
        instance_id: inst.id,
        instance_number: inst.instanceNumber,
        instance_status: inst.status,
        environment_id: environmentId,
      };
    }
    ```
  - 修改 `src/routes/web/environments.ts` 的 import: 将 `enterEnvironment` 从 `../../services/environment-web` 导入
  - 删除 `listInstancesResponse` 的所有引用（函数仅在 `/environments/:id/instances` 路由中使用，该路由已删除）
  - 原因: `enterEnvironment` 是 `/environments/:id/enter` 路由的业务逻辑，随 instance.ts 删除需迁移

- [x] 清理 `src/routes/web/index.ts` 的 instances 路由注册
  - 位置: `src/routes/web/index.ts`
  - 删除 L8: `import webInstances from "./instances";`
  - 删除 L28: `.use(webInstances)`
  - 原因: Instance 路由文件已删除

- [x] 清理 `src/services/environment-web.ts` 的 `groupActiveInstancesByEnvironment` 引用
  - 位置: `src/services/environment-web.ts`
  - 删除 L10: `import { groupActiveInstancesByEnvironment } from "./instance";`
  - 修改 `listEnvironmentsWithInstances` 函数（L112-158）:
    - 删除 L123-124 的 `const instanceMap = groupActiveInstancesByEnvironment();`
    - 删除循环中所有 instance 相关字段的组装（`session_id`、`instance_status`、`instance_id`、`instances`、`instances_count` 字段输出）
    - 改为返回不含 instance 信息的环境列表（每个环境仅返回自身字段 + agentName）
    - 具体：删除 L143-154 的 instance 相关字段，`results.push` 中仅保留环境自身字段（id/name/description/workspace_path/agent_config_id/agent_name/status/machine_name/branch/auto_start/last_poll_at/created_at/updated_at）
  - 原因: `groupActiveInstancesByEnvironment` 依赖 core facade 的 `listInstances()`，不再可用。`listEnvironmentsWithInstances` 函数名可保留但含义变为"环境列表"而非"环境+实例列表"

- [x] 清理 `src/services/hermes-client.ts` 的 instance import
  - 位置: `src/services/hermes-client.ts`
  - 修改 L3-6 import: 将:
    ```typescript
    import { sendToAgentWs } from "../transport/acp-ws-handler";
    import { sendToInstanceRelay } from "../transport/relay";
    import { findRunningInstanceByEnvironment } from "./instance";
    ```
    替换为:
    ```typescript
    import { sendToAgentWs } from "../transport/relay";
    import { findRunningInstanceByEnvironment, sendToInstanceRelay } from "../transport/relay";
    ```
  - 原因: `sendToAgentWs` 已由 Task 1 在 acp-ws-handler.ts 中替换为 machine WS 实现并继续导出、Task 2 在 relay-handler.ts 中新增兼容版本。`sendToInstanceRelay` 和 `findRunningInstanceByEnvironment` 由 Task 2 在 relay-handler.ts 中实现。统一从 relay 导出

- [x] 清理 `src/services/workflow/acp-transport.ts` 的旧 import
  - 位置: `src/services/workflow/acp-transport.ts`
  - 修改 L13: 将 `import { findAcpConnectionByAgentId, sendToAgentWs } from "../../transport/acp-ws-handler";` 替换为:
    ```typescript
    import { sendToAgentWs } from "../../transport/relay";
    ```
  - 修改 L191: 将 `const conn = findAcpConnectionByAgentId(agentId);` 替换为:
    ```typescript
    const { findMachineConnectionByAgentId } = await import("../../transport/acp-ws-handler");
    const conn = await findMachineConnectionByAgentId(agentId);
    ```
  - 原因: `findAcpConnectionByAgentId` 已在 Task 1 删除，替换为 `findMachineConnectionByAgentId`。`sendToAgentWs` 统一从 relay 导入

- [x] 删除 `src/types/store.ts` 中的 `InstanceSupplement` 接口
  - 位置: `src/types/store.ts`，删除 L73-82 的 `InstanceSupplement` 接口定义及其注释
  - 原因: Instance 概念废弃

- [x] 为代码清理编写验证性单元测试
  - 测试文件: 复用现有测试文件，验证以下:
    - `src/__tests__/registry-routes.test.ts` 仍然通过
    - `src/__tests__/registry-service.test.ts` 仍然通过
    - `src/__tests__/registry-schema.test.ts` 仍然通过
  - 运行命令: `bun test src/__tests__/registry-routes.test.ts src/__tests__/registry-service.test.ts src/__tests__/registry-schema.test.ts`
  - 预期: 全部现有测试通过（验证删除操作未破坏无关模块）

**检查步骤:**

- [x] 验证 instance 相关文件已删除
  - `ls /Users/zhongym29/FenixAgent/src/services/instance.ts /Users/zhongym29/FenixAgent/src/routes/web/instances.ts /Users/zhongym29/FenixAgent/src/schemas/instance.schema.ts 2>&1`
  - 预期: 所有文件 "No such file or directory"

- [x] 验证 instance 测试文件已删除
  - `ls /Users/zhongym29/FenixAgent/src/__tests__/instance-*.test.ts 2>&1`
  - 预期: "No such file or directory"

- [x] 验证 `src/index.ts` 无 instance 引用
  - `grep -n "instance\|Instance\|stopAllInstances" /Users/zhongym29/FenixAgent/src/index.ts`
  - 预期: 无匹配（或仅保留注释）

- [x] 验证 `src/routes/web/index.ts` 无 instances 注册
  - `grep -n "instances\|Instances" /Users/zhongym29/FenixAgent/src/routes/web/index.ts`
  - 预期: 无匹配

- [x] 验证 `InstanceSupplement` 已从 types/store.ts 删除
  - `grep -n "InstanceSupplement" /Users/zhongym29/FenixAgent/src/types/store.ts`
  - 预期: 无匹配

- [x] 运行 precheck
  - `bun run precheck 2>&1 | tail -20`
  - 预期: precheck 通过（或仅有前端警告）

---

### Task 5: acp-link SessionManager — session 生命周期管理

**背景:**
acp-link 在 client 模式（`--rcs-url` 启动）下需要新增 SessionManager，管理远端 RCS 通过 machine WS 下发的 session 生命周期请求。当前 acp-link client 模式的 `createAcpClient`（`packages/acp-link/src/server.ts` L271-317）只处理 `registered` 消息，收到后仅发送 heartbeat。改造后需要解析 `session_start`/`session_data`/`session_end` 三种 session 消息，spawn agent 子进程并桥接 stdio。

经代码确认：acp-link server.ts L431-433 已有 `spawn(command, args, {cwd, stdio: ["pipe", "pipe", "inherit"]})` 的 agent 启动逻辑，但只在 server 模式的 `handleConnect` 中使用。`createAcpClient` 当前不处理任何 session 消息。

**涉及文件:**
- 新建: `packages/acp-link/src/client/session-manager.ts`
- 修改: `packages/acp-link/src/server.ts`

**执行步骤:**

- [x] 新建 `SessionManager` 类
  - 文件: `packages/acp-link/src/client/session-manager.ts`
  - 关键设计:
    - 维护 `Map<sessionId, ChildProcess>` 管理活跃 session
    - 维护 `Map<sessionId, WritableStream>` 管理子进程 stdin writer
    - max_sessions 默认 5，可配置
    - agent_name 由注册时的 `buildRegisterMessage` 传入，spawn 命令固定为 `<agent_name> acp`
  - 关键方法:
    ```typescript
    import { spawn, type ChildProcess } from "node:child_process";
    import { Writable } from "node:stream";

    export class SessionManager {
      private sessions = new Map<string, ChildProcess>();
      private stdinWriters = new Map<string, WritableStream<Uint8Array>>();
      private readonly maxSessions: number;
      private readonly agentName: string;

      constructor(agentName: string, maxSessions = 5) {
        this.agentName = agentName;
        this.maxSessions = maxSessions;
      }

      get activeCount(): number { return this.sessions.size; }

      async startSession(sessionId: string): Promise<"started" | "queued" | "error"> {
        if (this.sessions.has(sessionId)) return "started"; // 幂等
        if (this.sessions.size >= this.maxSessions) return "queued";

        try {
          const proc = spawn(this.agentName, ["acp"], {
            stdio: ["pipe", "pipe", "inherit"],
          });

          const stdin = Writable.toWeb(proc.stdin!);
          this.stdinWriters.set(sessionId, stdin);

          proc.on("exit", (code) => {
            this.sessions.delete(sessionId);
            this.stdinWriters.delete(sessionId);
            this.emit("session_ended", sessionId, code ?? 0);
          });

          // stdout 逐行解析 NDJSON → session_data
          // 使用 readline 或手动 split('\n')
          proc.stdout!.on("data", (chunk: Buffer) => {
            const lines = chunk.toString().split("\n").filter(l => l.trim());
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                this.emit("session_data", sessionId, parsed);
              } catch { /* skip non-JSON output */ }
            }
          });

          this.sessions.set(sessionId, proc);
          return "started";
        } catch (err) {
          return "error";
        }
      }

      sendData(sessionId: string, payload: unknown): boolean {
        const writer = this.stdinWriters.get(sessionId);
        if (!writer) {
          // lazy spawn: 收到未知 session_id 的 session_data 时自动 start
          this.startSession(sessionId).then(result => {
            if (result === "started") {
              const w = this.stdinWriters.get(sessionId);
              if (w) {
                const line = JSON.stringify(payload) + "\n";
                const enc = new TextEncoder().encode(line);
                w.getWriter().write(enc);
              }
            }
          });
          return true; // 已触发 lazy spawn
        }
        const line = JSON.stringify(payload) + "\n";
        const enc = new TextEncoder().encode(line);
        writer.getWriter().write(enc);
        return true;
      }

      async endSession(sessionId: string): Promise<void> {
        const proc = this.sessions.get(sessionId);
        if (!proc) return;
        proc.kill("SIGTERM");
        // 等待 5s 后强杀
        setTimeout(() => {
          if (this.sessions.has(sessionId)) {
            proc.kill("SIGKILL");
          }
        }, 5000);
      }

      stopAll(): void {
        for (const [sessionId, proc] of this.sessions) {
          proc.kill("SIGTERM");
        }
        this.sessions.clear();
        this.stdinWriters.clear();
      }

      // Event emitter methods (简化为回调)
      private listeners = new Map<string, Array<(...args: any[]) => void>>();
      on(event: string, cb: (...args: any[]) => void): void {
        const arr = this.listeners.get(event) ?? [];
        arr.push(cb);
        this.listeners.set(event, arr);
      }
      private emit(event: string, ...args: any[]): void {
        this.listeners.get(event)?.forEach(cb => cb(...args));
      }
    }
    ```
  - 原因: SessionManager 封装 session 生命周期，与 acp-link 的传输层解耦。lazy spawn 支持无需显式 `session_start` 的场景（hermes-client、workflow 调用 `sendToAgentWs` 时自动触发）

- [x] 集成 SessionManager 到 `createAcpClient`
  - 位置: `packages/acp-link/src/server.ts` 的 `createAcpClient` 函数（~L271-317）
  - 修改 `ws.onmessage` 回调（L285-300），新增 session 消息处理:
    ```typescript
    import { SessionManager } from "./client/session-manager.js";

    // 在 ws.onopen 构建 register 消息时提取 agentName
    // 在模块顶层或 createAcpClient 函数内创建 SessionManager:
    const sessionMgr = new SessionManager(config.command, 5);

    // 注册 SessionManager 事件回调（在 createAcpClient 内、ws 创建后）:
    sessionMgr.on("session_data", (sessionId: string, payload: unknown) => {
      ws.send(JSON.stringify({ type: "session_data", session_id: sessionId, payload }));
    });
    sessionMgr.on("session_ended", (sessionId: string, exitCode: number) => {
      ws.send(JSON.stringify({ type: "session_ended", session_id: sessionId, reason: `exit code ${exitCode}` }));
    });

    // ws.onmessage 中新增消息类型:
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case "registered":
            console.log("[acp-client] registered successfully, machineId:", msg.machine_id);
            // heartbeat 照旧
            heartbeatTimer = setInterval(() => {
              ws.send(JSON.stringify({ type: "heartbeat" }));
            }, 30000);
            break;
          case "session_start":
            sessionMgr.startSession(msg.session_id).then(result => {
              if (result === "started") {
                ws.send(JSON.stringify({ type: "session_started", session_id: msg.session_id }));
              } else if (result === "queued") {
                ws.send(JSON.stringify({ type: "session_queued", session_id: msg.session_id }));
              } else {
                ws.send(JSON.stringify({ type: "session_error", session_id: msg.session_id, error: "spawn failed" }));
              }
            });
            break;
          case "session_data":
            // msg.payload 直接写入子进程 stdin
            sessionMgr.sendData(msg.session_id, msg.payload);
            break;
          case "session_end":
            sessionMgr.endSession(msg.session_id);
            break;
          default:
            console.log(`[acp-client] received: ${msg.type}`);
        }
      } catch { /* ignore parse errors */ }
    };

    // ws.onclose 中清理所有 session:
    // 在原有 onclose 中添加: sessionMgr.stopAll();
    ```
  - 修改 `createAcpClient` 返回值: close 方法中先 `sessionMgr.stopAll()` 再 `ws.close()`
  - 原因: SessionManager 接管 agent 子进程生命周期，与 WS 传输层通过事件桥接

- [x] 为 SessionManager 编写单元测试
  - 测试文件: `packages/acp-link/src/__tests__/session-manager.test.ts`（新建）
  - 测试场景:
    - `startSession` 成功 spawn 返回 "started": mock spawn 返回正常子进程 → 调用 `startSession("ses_1")` → 返回 "started"，`activeCount === 1`
    - `startSession` 超限返回 "queued": 设置 maxSessions=1，先 startSession("ses_1") 再 startSession("ses_2") → 返回 "queued"，`activeCount === 1`
    - `startSession` 幂等: 两次 startSession 同一个 sessionId → 均返回 "started"，`activeCount === 1`
    - `sendData` 写入子进程 stdin: mock stdin writer → `sendData("ses_1", {type: "init"})` → writer 收到 NDJSON 序列化的数据
    - `sendData` 对未知 sessionId 触发 lazy spawn: startSession spy → `sendData("ses_unknown", {type: "test"})` → startSession 被调用
    - `endSession` kill 子进程: `endSession("ses_1")` → proc.kill("SIGTERM") 被调用
    - 子进程 stdout 输出触发 session_data 事件: mock stdout data chunk → 验证 `on("session_data")` 回调被调用
    - 子进程 exit 触发 session_ended 事件: mock proc "exit" → 验证 `on("session_ended")` 回调被调用
  - 运行命令: `cd /Users/zhongym29/FenixAgent/packages/acp-link && bun test src/__tests__/session-manager.test.ts`
  - 预期: 全部 8 个测试通过

**检查步骤:**

- [x] 验证 SessionManager 文件存在
  - `ls /Users/zhongym29/FenixAgent/packages/acp-link/src/client/session-manager.ts`
  - 预期: 文件存在

- [x] 验证 `createAcpClient` 中集成了 SessionManager
  - `grep -n "session_start\|session_data\|session_end\|SessionManager" /Users/zhongym29/FenixAgent/packages/acp-link/src/server.ts`
  - 预期: 找到 session 消息处理逻辑和 SessionManager import

- [x] 运行 acp-link 单元测试
  - `cd /Users/zhongym29/FenixAgent/packages/acp-link && bun test src/__tests__/session-manager.test.ts`
  - 预期: 全部测试通过

- [x] 运行 acp-link 现有测试确保无回归
  - `cd /Users/zhongym29/FenixAgent/packages/acp-link && bun test`
  - 预期: 全部已有测试通过

---

### Task 6: acp-link 重连恢复与排队机制

**背景:**
machine WS 断连后 acp-link 需要自动重连 RCS（指数退避），重连时已运行的子进程继续运行不 kill，重连成功后通过 `session_resumed` 恢复 RCS 侧的 relay 桥接。此外，当 machine 上活跃 session 数达到 `max_sessions` 上限时，新请求进入等待队列，有空闲 slot 后自动启动，队列超时（默认 120s）返回 `session_error`。

经代码确认：acp-link 的 `WSTransport`（`packages/acp-link/src/client/transport.ts`）已有自动重连机制（指数退避最多 3 次），但 `createAcpClient` 不使用 `WSTransport`，而是直接用 `new WebSocket(url)`。当前 `createAcpClient` 无重连逻辑，WS 断连后 client 模式停止工作。

**涉及文件:**
- 修改: `packages/acp-link/src/client/session-manager.ts`
- 修改: `packages/acp-link/src/server.ts`

**执行步骤:**

- [x] 在 `SessionManager` 中新增等待队列和恢复方法
  - 位置: `packages/acp-link/src/client/session-manager.ts`
  - 新增加字段:
    ```typescript
    private queue: Array<{ sessionId: string; timeout: ReturnType<typeof setTimeout> }> = [];
    private readonly QUEUE_TIMEOUT_MS = 120_000;
    ```
  - 修改 `startSession` 的 "queued" 分支，加入队列:
    ```typescript
    // 在返回 "queued" 前:
    const timeout = setTimeout(() => {
      // 队列超时：从队列中移除
      this.queue = this.queue.filter(q => q.sessionId !== sessionId);
      this.emit("session_error", sessionId, "queue_timeout");
    }, this.QUEUE_TIMEOUT_MS);
    this.queue.push({ sessionId, timeout });
    ```
  - 新增 `getAliveSessionIds()` 方法:
    ```typescript
    getAliveSessionIds(): string[] {
      return Array.from(this.sessions.keys());
    }
    ```
  - 新增 `resumeSession(sessionId: string): void` 方法（用于重连后恢复已存活的子进程）:
    ```typescript
    /** 标记已有的子进程 session 为"已恢复"，不需重新 spawn */
    hasSession(sessionId: string): boolean {
      return this.sessions.has(sessionId);
    }
    ```
  - 修改 `endSession` 在子进程退出后处理队列:
    ```typescript
    // 在 proc.on("exit") 回调中 "this.emit('session_ended', ...)" 之后添加:
    // 从队列中取出下一个，立即 spawn
    const next = this.queue.find(() => true); // 取第一个
    if (next) {
      clearTimeout(next.timeout);
      this.queue = this.queue.filter(q => q.sessionId !== next.sessionId);
      this.startSession(next.sessionId);
    }
    ```
  - 原因: 队列 FIFO 公平调度，超时清除避免无限等待

- [x] 在 `createAcpClient` 中实现自动重连
  - 位置: `packages/acp-link/src/server.ts` 的 `createAcpClient` 函数
  - 重构函数结构: 将 WS 连接逻辑提取为 `connect()` 内部函数
  - 关键实现:
    ```typescript
    export function createAcpClient(config: ServerConfig): { close: () => void } {
      const sessionMgr = new SessionManager(config.command, 5);
      const url = `${config.rcsUrl}/acp/ws?secret=${encodeURIComponent(config.rcsSecret ?? "")}`;
      let ws: WebSocket | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let reconnectAttempt = 0;
      const MAX_RECONNECT_MS = 30_000; // 最大重连间隔
      let manualClose = false;

      function connect(): void {
        if (manualClose) return;
        ws = new WebSocket(url);

        ws.onopen = () => {
          reconnectAttempt = 0;
          ws!.send(JSON.stringify(buildRegisterMessage(config)));

          // 重连后：为所有存活的子进程发送 session_resumed
          for (const sessionId of sessionMgr.getAliveSessionIds()) {
            ws!.send(JSON.stringify({ type: "session_resumed", session_id: sessionId }));
          }
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            switch (msg.type) {
              case "registered":
                // heartbeat 照旧
                heartbeatTimer = setInterval(() => {
                  ws?.send(JSON.stringify({ type: "heartbeat" }));
                }, 30000);
                break;
              case "session_start":
                // ... (同 Task 5)
                break;
              case "session_data":
                sessionMgr.sendData(msg.session_id, msg.payload);
                break;
              case "session_end":
                sessionMgr.endSession(msg.session_id);
                break;
            }
          } catch {}
        };

        ws.onclose = (event) => {
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          if (manualClose) return;
          // 指数退避重连
          const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
          reconnectAttempt++;
          console.log(`[acp-client] disconnected, reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
          setTimeout(connect, delay);
        };

        ws.onerror = () => { /* ws.onclose 会触发 */ };
      }

      connect();

      return {
        close: () => {
          manualClose = true;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          sessionMgr.stopAll();
          ws?.close();
        },
      };
    }
    ```
  - 删除旧 `createAcpClient` 中的一次性 ws 创建和 onclose 逻辑（原 L276-317）
  - 在 `startServer` 的 shutdown 回调（L948-953）中调用 `handle.close()` 触发 `sessionMgr.stopAll()`
  - 原因: 指数退避重连确保网络恢复后自动重新注册。session_resumed 告知 RCS 恢复 relay 桥接。manualClose 标志区分主动关闭和断连重连

- [x] RCS 侧 machine 断连处理（relay-handler.ts 补充）
  - 位置: `src/transport/relay/relay-handler.ts` 的 `openMachineRelay` 函数中，在 `machineConn.onSessionMessage` 赋值后
  - 新增 `handleAcpWsClose` 的扩展逻辑：machine 连接关闭时需通知关联的 relay entry。在 `src/transport/acp-ws-handler.ts` 的 `handleAcpWsClose` 中（~L370-402），在 machine 断连后遍历 relay connections:
    ```typescript
    // 在 handleAcpWsClose 中，handleMachineDisconnect 调用之后，connections.delete 之前:
    if (entry.isMachine && entry.machineId) {
      // 通知 relay-handler 层的所有关联 relay entry
      const { handleMachineDisconnected } = await import("../transport/relay/relay-handler");
      handleMachineDisconnected(entry.machineId);
    }
    ```
  - 在 `relay-handler.ts` 新增 `handleMachineDisconnected` 导出函数:
    ```typescript
    export function handleMachineDisconnected(machineId: string): void {
      for (const [relayWsId, entry] of manager.entries()) {
        if (entry.instanceId === machineId) {
          entry.pendingReconnect = true;
          entry.machineWsId = undefined;
          log(`[ACP-Relay] Machine ${machineId} disconnected, relay ${relayWsId} pending reconnect`);
        }
      }
    }
    ```
  - 在 `openMachineRelay` 中，收到 `session_resumed` 时清除 `pendingReconnect` 并恢复通信（已在 Task 2 的 `onSessionMessage` 回调中处理 `session_resumed` 分支）
  - 原因: machine 断连后 relay WS 保持连接不关闭（验收标准第10条），等待 machine 重连后通过 `session_resumed` 恢复

- [x] 为队列和重连编写单元测试
  - 测试文件: `packages/acp-link/src/__tests__/session-manager.test.ts`（追加场景）
  - 追加测试场景:
    - 队列超时触发 session_error: startSession 返回 "queued" → 等待 120s（mock timer advance）→ 验证 `on("session_error")` 回调被调用，参数包含 "queue_timeout"
    - endSession 后从队列取下一个: maxSessions=1，startSession("A") → started, startSession("B") → queued → endSession("A") → 验证 B 自动 startSession
    - getAliveSessionIds 返回存活 session 列表: startSession("A"), startSession("B") → `getAliveSessionIds()` 返回 ["A", "B"]
    - stopAll 终止所有 session: startSession("A"), startSession("B") → stopAll() → activeCount === 0
  - 运行命令: `cd /Users/zhongym29/FenixAgent/packages/acp-link && bun test src/__tests__/session-manager.test.ts`
  - 预期: 全部测试通过

**检查步骤:**

- [x] 验证 `SessionManager` 有队列相关逻辑
  - `grep -n "queue\|QUEUE_TIMEOUT\|session_error.*queue_timeout" /Users/zhongym29/FenixAgent/packages/acp-link/src/client/session-manager.ts`
  - 预期: 找到队列超时和 session_error 相关逻辑

- [x] 验证 `createAcpClient` 有重连逻辑
  - `grep -n "reconnect\|session_resumed\|manualClose\|setTimeout.*connect" /Users/zhongym29/FenixAgent/packages/acp-link/src/server.ts`
  - 预期: 找到重连指数退避和 session_resumed 发送逻辑

- [x] 验证 relay-handler.ts 有 `handleMachineDisconnected`
  - `grep -n "handleMachineDisconnected\|pendingReconnect" /Users/zhongym29/FenixAgent/src/transport/relay/relay-handler.ts`
  - 预期: 找到函数定义和 pendingReconnect 标记逻辑

- [x] 运行单元测试
  - `cd /Users/zhongym29/FenixAgent/packages/acp-link && bun test src/__tests__/session-manager.test.ts`
  - 预期: 全部测试通过

---

### Task 7: 前端适配 — 移除 Instance 页面、添加远端状态展示

**背景:**
Instance 概念废弃后，前端不再需要 Instance 管理页面和相关状态展示。同时需要新增远端 session 执行状态展示（排队中、远端执行中）。远端 session 对前端透明——前端仍然连接 `/acp/relay/:agentId`，消息格式不变。

经代码确认：前端没有独立的 Instance 管理页面。Instance 相关信息分散在：
- `web/src/components/EnvironmentList.tsx`：使用 `InstanceInfo` 类型和 instance 相关 UI
- `web/src/pages/EnvironmentsPage.tsx`：环境管理页面
- `web/src/types/index.ts`：类型定义中的 Instance 相关字段
- `web/src/api/client.ts`：API client 中的 instance endpoint
- `web/src/api/sdk.ts`：SDK 中的 instance API

**涉及文件:**
- 修改: `web/src/components/EnvironmentList.tsx`
- 修改: `web/src/pages/EnvironmentsPage.tsx`
- 修改: `web/src/types/index.ts`
- 修改: `web/src/api/sdk.ts`

**执行步骤:**

- [x] 清理 `EnvironmentList` 组件的 Instance 相关逻辑
  - 位置: `web/src/components/EnvironmentList.tsx`
  - 删除: `InstanceInfo` 类型定义（L5-11）
  - 修改 `EnvironmentListProps`:
    - 删除 `instances: InstanceInfo[]` prop
    - 删除 `onStopInstance?: (instanceId: string) => void` prop
  - 简化组件逻辑:
    - 删除 `instanceMap` 构建（L27-30）
    - 删除 `matchedGroupIds` 和 `unmatchedInstances` 逻辑（L40-47）
    - 删除 unmatched instances 渲染区域（L107-125，即孤立实例列表）
    - 删除环境卡片中的 instance 状态指示器（`instanceMap.get(env.channel_group_id || "")` 相关代码 L85-94）
  - 原因: Instance 概念废弃，`EnvironmentList` 只需要展示环境基本信息（名称、状态、machine 名称等）

- [x] 清理 `EnvironmentsPage` 的 Instance 相关逻辑
  - 位置: `web/src/pages/EnvironmentsPage.tsx`
  - 需要先读文件确认当前 Instance 相关代码
  - 预期操作:
    - 删除 instance 列表获取逻辑（如果存在）
    - 删除传递给 `EnvironmentList` 的 `instances` 和 `onStopInstance` props
    - 删除 Instance spawn/stop 相关的 toast 提示

- [x] 清理 `web/src/types/index.ts` 中的 Instance 相关类型
  - 位置: `web/src/types/index.ts`
  - 操作: 搜索并删除 Instance 相关类型定义（`InstanceInfo`、`SpawnedInstance`、instance 相关 API 响应类型等）

- [x] 删除 `web/src/api/sdk.ts` 中的 instance API 方法
  - 位置: `web/src/api/sdk.ts`
  - 操作: 搜索并删除 instance 相关 API 方法（如 `spawnInstance`、`stopInstance`、`listInstances` 等）

- [x] 新增远端状态指示：`session_queued` 排队状态展示（可选前端体验增强）
  - 位置: `web/src/acp/` 目录下的 ACP relay 客户端代码
  - 检查是否有 relay 消息处理逻辑，添加 `session_queued` 状态转发到 UI:
    - relay WS 收到 `{type: "status", payload: {connected: false, queued: true}}` 时（Task 2 的 `openMachineRelay` 中 `onSessionMessage("session_queued")` 产生）
    - 前端展示"排队中"提示（如 toast 或 status badge）
  - 原因: 远端 session 执行对前端透明，但排队是新增的用户可见状态

- [x] 前端构建验证
  - 运行命令: `bun run build:web 2>&1 | tail -10`
  - 预期: 构建成功，无 TypeScript 错误
  - 注意: 构建失败时检查 `tsc` 输出定位残留的 Instance 类型引用

**检查步骤:**

- [x] 验证 `EnvironmentList` 无 Instance 相关类型引用
  - `grep -n "InstanceInfo\|instanceMap\|unmatchedInstances\|onStopInstance" /Users/zhongym29/FenixAgent/web/src/components/EnvironmentList.tsx`
  - 预期: 无匹配

- [x] 验证前端类型定义无 Instance 引用
  - `grep -rn "InstanceInfo\|SpawnedInstance\|spawnInstance\|stopInstance" /Users/zhongym29/FenixAgent/web/src/types/index.ts 2>/dev/null`
  - 预期: 无匹配

- [x] 验证前端构建成功
  - `bun run build:web 2>&1 | tail -5`
  - 预期: 输出包含构建成功信息，无 error

- [x] 验证 session_queued 状态转发逻辑存在（可选增强）
  - `grep -rn "session_queued\|queued" /Users/zhongym29/FenixAgent/web/src/acp/ 2>/dev/null`
  - 预期: 找到 queued 状态处理（如已实现）或确认该增强标记为后续迭代

---

### Task 8: 注册中心第二期 relay 统一化 验收

**前置条件:**
- 所有 Task 1-7 执行完毕
- 数据库已运行（`DATABASE_URL` 已配置）
- `REGISTRY_SECRET` 环境变量已设置（用于 machine 注册认证）
- acp-link 包已构建（如需要）

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `bun run precheck 2>&1 | tail -20`
   - 预期: precheck 通过
   - 失败排查: 检查各 Task 的测试步骤，确认所有新增/修改文件通过 biome 格式化和 tsc 类型检查

2. 运行后端全部测试
   - `cd /Users/zhongym29/FenixAgent && bun test src/__tests__/ 2>&1 | tail -30`
   - 预期: 全部测试通过（删除 7 个 instance 测试文件后测试总数减少）
   - 失败排查: 检查各 Task 的单元测试步骤，确认 mock 与新接口签名匹配

3. 验证 `/acp/ws` 拒绝非 machine 连接（验收标准第1条）
   - `cd /Users/zhongym29/FenixAgent && bun test src/__tests__/acp-ws-auth.test.ts 2>&1 | tail -10`
   - 预期: 全部 4 个测试通过（包括 secret 不匹配、无 secret、空 secret 场景）
   - 失败排查: 检查 Task 3 的端点简化是否正确执行

4. 验证 session 消息在 machine WS 上的转发（验收标准第3-5条）
   - `cd /Users/zhongym29/FenixAgent && bun test src/__tests__/relay-handler-machine.test.ts 2>&1 | tail -10`
   - 预期: 全部 8 个测试通过（包括 session_start 发送、session_started 解缓冲、session_data 透传、session_ended 关闭等）
   - 失败排查: 检查 Task 1 的 session 消息转发和 Task 2 的 openMachineRelay 回调链路

5. 验证 acp-link SessionManager session 生命周期（验收标准第3-5,7-8条）
   - `cd /Users/zhongym29/FenixAgent/packages/acp-link && bun test src/__tests__/session-manager.test.ts 2>&1 | tail -10`
   - 预期: 全部测试通过（包括 spawn/lazy spawn/end/queue 等场景）
   - 失败排查: 检查 Task 5 和 Task 6 的 SessionManager 实现

6. 验证兼容层函数签名不变（验收标准第12-14条）
   - `grep -n "export function sendToAgentWs\|export.*findRunningInstanceByEnvironment\|export.*spawnInstanceFromEnvironment\|export function sendToInstanceRelay\|export function closeInstanceRelay" /Users/zhongym29/FenixAgent/src/transport/relay/relay-handler.ts`
   - 预期: 全部 5 个兼容层函数找到，签名与 spec-design.md 定义一致
   - 失败排查: 检查 Task 2 的兼容层函数实现

7. 验证旧代码已删除（验收标准第15-16条）
   - `ls /Users/zhongym29/FenixAgent/src/services/instance.ts /Users/zhongym29/FenixAgent/src/routes/web/instances.ts /Users/zhongym29/FenixAgent/src/schemas/instance.schema.ts 2>&1`
   - 预期: "No such file or directory"
   - `grep -rn "findAcpConnectionByAgentId\|handleIdentify\|openInstanceRelay\|openEventBusRelay\|handleAcpRegister" /Users/zhongym29/FenixAgent/src/ --include="*.ts" | grep -v __tests__ | grep -v ".test.ts"`
   - 预期: 无匹配（所有旧函数定义和调用已删除）
   - 失败排查: 检查 Task 1（删除 acp-ws-handler 旧函数）、Task 2（删除 relay-handler 旧路径）、Task 4（删除 instance 模块）

8. 验证前端构建成功（验收标准第17条）
   - `cd /Users/zhongym29/FenixAgent && bun run build:web 2>&1 | tail -5`
   - 预期: 构建成功，无 error
   - 失败排查: 检查 Task 7 的前端 Instance 清除，确认无残留的 Instance 类型引用

9. 验证 acp-link 不传 --rcs-url 时行为不变（验收标准第18条）
   - `cd /Users/zhongym29/FenixAgent/packages/acp-link && bun test 2>&1 | tail -10`
   - 预期: 全部已有测试通过（server 模式不受影响）
   - 失败排查: 检查 `server.ts` 的 `createAcpServer` 函数未被修改，`startServer` 在无 `rcsUrl` 时走 server 分支

10. 验证 `REGISTRY_SECRET` 不匹配时注册被拒绝（验收标准第19条）
    - `cd /Users/zhongym29/FenixAgent && bun test src/__tests__/acp-ws-auth.test.ts --test-name-pattern "不匹配" 2>&1 | tail -10`
    - 预期: REGISTRY_SECRET 不匹配场景的测试通过
    - 失败排查: 检查 Task 3 的 `/acp/ws` 端点 secret 校验逻辑

11. 验证多 machine Docker 容器端到端对话（验收标准第20条：不同 Agent 绑定不同 machine，各自正确对话）
    **前置条件:**
    - RCS dev server 在 3000 端口运行，`REGISTRY_SECRET=test-secret-2026`
    - Docker Desktop 已启动，Clash Verge 开启"允许局域网连接"
    - 已设置 `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` 环境变量（Docker 内 opencode 需要模型 API）

    **步骤:**
    a. 启动两台 machine Docker 容器
       ```bash
       ANTHROPIC_API_KEY=sk-xxx ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
       REGISTRY_SECRET=test-secret-2026 \
       docker compose -f docker-compose.machines.yml up -d --build
       ```
       预期: `fenix-machine-a` 和 `fenix-machine-b` 启动，日志显示 `[acp-client] registered successfully, machineId: mach_xxx`

    b. 清空旧数据（保留模型和用户），重建 agent 配置
       - 登录 RCS，清空 DB 中 agent_config / environment / machine / session 等表（保留 provider / model / user / organization）
       - 通过 API 创建 3 个 agent 并绑定 machine：
         - `zyma`: prompt="你叫小a", model="zym/deepseek-v4-flash", machineId=machine-a
         - `zymb`: prompt="你是一只鸡，说话要模仿鸡", model="zym/deepseek-v4-flash", machineId=machine-b
         - `zymc`: prompt="你是一只狗，说话要模仿狗", model="zym/deepseek-v4-flash", machineId=machine-a（共享）
       预期: agent 创建成功，machine 绑定正确

    c. 浏览器验证 — zyma on machine-a
       - 打开 `http://localhost:3000/ctrl`，登录 `1@qq.com / 12345678`
       - 点击左侧 zyma 的"新建实例"
       预期: 环境创建成功，进入聊天界面，model 显示 "OpenCode Zen/Big Pickle"（非 "Select Model"）
       - 发送 "你叫什么名字？"
       预期: 回复中包含 "小a"（提示词生效），收到 `prompt_complete`，不会卡在"思考中"

    d. 浏览器验证 — zymb on machine-b
       - 点击左侧 zymb 的"新建实例"
       预期: 环境创建成功，进入聊天界面
       - 发送 "你好，请用一句话介绍你自己"
       预期: 回复中包含鸡叫风格（如"咯咯哒"），确认来自 machine-b 的 opencode 进程

    e. 浏览器验证 — zymc on machine-a（共享）
       - 点击左侧 zymc 的"新建实例"
       预期: 环境创建成功，进入聊天界面
       - 发送 "你好"
       预期: 回复中包含狗叫风格（如"汪汪"），确认 zymc 与 zyma 共享 machine-a 且各自提示词生效

    f. 验证 load_session（会话历史加载）
       - 在 zyma 会话列表点击已有会话
       预期: 会话历史完整加载，可继续对话，agent 能回忆之前的上下文

    g. 验证新建会话 + 切换
       - 点击"新会话"创建新会话，发送消息
       - 切换到旧会话
       预期: 旧会话上下文保留，新会话独立

    **失败排查:**
    - machine 注册失败 → 检查 RCS 日志中 `REGISTRY_SECRET` 是否匹配，检查 Docker 网络 `host.docker.internal:3000` 是否可达
    - 新建实例报错 → 检查 `POST /web/environments` 和 `POST /web/environments/:id/enter` 响应，检查 `environment-web.ts` 中 machine 查询是否正确
    - 提示词不生效 → 检查 relay-handler 中 `agent_prompt` 是否正确传递到 SessionManager，检查 SessionManager 中 `systemPrompt` 是否在第一个 prompt 时注入
    - 模型显示 "Select Model" → 检查 SessionManager 的 `setSessionModel` / `setSessionMode` 是否缺少 `sessionId` 参数
    - load_session 失败 → 检查 SessionManager 的 `loadSession` 调用是否包含 `cwd` 和 `mcpServers` 参数

---

