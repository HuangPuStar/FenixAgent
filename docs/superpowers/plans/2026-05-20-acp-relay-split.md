# ACP Relay Handler Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 421-line `acp-relay-handler.ts` monolith into 3 focused modules with clear seams: connection management, message routing, and WebSocket protocol glue.

**Architecture:** The current file mixes connection lifecycle (Map of relay entries), message filtering/forwarding (keep_alive interception, outbound buffering), and protocol handling (open/close/message). We split along these three seams. `RelayConnectionManager` owns the `relayConnections` Map and provides typed access. `RelayMessageRouter` handles message filtering, buffering, and forwarding. The main handler retains only the Elysia/WebSocket protocol glue.

**Tech Stack:** Bun WebSocket, existing `WsConnection` type, `@mothership/plugin-sdk` EngineRelayHandle

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/transport/relay/connection-manager.ts` | Relay connection registry: add/remove/find, lifecycle tracking |
| `src/transport/relay/message-router.ts` | Message filtering (keep_alive), outbound buffer, bidirectional forwarding |
| `src/transport/relay/relay-handler.ts` | WebSocket protocol glue: open/close/message event handlers |
| `src/transport/relay/index.ts` | Barrel re-export of public API |
| `src/transport/acp-relay-handler.ts` | Deleted (replaced by `relay/` directory) |
| `src/__tests__/relay-connection-manager.test.ts` | Unit tests for connection manager |
| `src/__tests__/relay-message-router.test.ts` | Unit tests for message router |

---

### Task 1: Create RelayConnectionManager

**Files:**
- Create: `src/transport/relay/connection-manager.ts`
- Create: `src/__tests__/relay-connection-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/relay-connection-manager.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
// 测试 RelayConnectionManager 的连接注册/注销/查找

describe("RelayConnectionManager", () => {
  // We'll import after module creation
  let manager: import("../transport/relay/connection-manager").RelayConnectionManager;

  beforeEach(() => {
    const { RelayConnectionManager: Mgr } = require("../transport/relay/connection-manager");
    manager = new Mgr();
  });

  test("add and find a connection", () => {
    const wsId = "relay-1";
    const entry = {
      agentId: "agent-1",
      userId: "user-1",
      unsub: null,
      keepalive: null,
      ws: { readyState: 1 } as any,
      openTime: Date.now(),
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    };
    manager.add(wsId, entry);
    expect(manager.get(wsId)).toEqual(entry);
  });

  test("remove a connection and clean up", () => {
    const wsId = "relay-2";
    const clearedTimers: number[] = [];
    const entry = {
      agentId: "agent-1",
      userId: "user-1",
      unsub: null,
      keepalive: { clearInterval: () => clearedTimers.push(1) } as unknown as ReturnType<typeof setInterval>,
      ws: { readyState: 1 } as any,
      openTime: Date.now(),
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    };
    manager.add(wsId, entry);
    manager.remove(wsId);
    expect(manager.get(wsId)).toBeUndefined();
    expect(clearedTimers.length).toBe(1);
  });

  test("get returns undefined for unknown wsId", () => {
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  test("clearAll removes all connections", () => {
    manager.add("a", { agentId: "a", userId: "u", unsub: null, keepalive: null, ws: {} as any, openTime: 0, instanceId: null, relayHandle: null, relayUnsub: null, outboundBuffer: [] });
    manager.add("b", { agentId: "b", userId: "u", unsub: null, keepalive: null, ws: {} as any, openTime: 0, instanceId: null, relayHandle: null, relayUnsub: null, outboundBuffer: [] });
    manager.clearAll();
    expect(manager.get("a")).toBeUndefined();
    expect(manager.get("b")).toBeUndefined();
  });

  test("findByInstance returns connection matching instanceId", () => {
    manager.add("r1", { agentId: "a", userId: "u", unsub: null, keepalive: null, ws: {} as any, openTime: 0, instanceId: "inst-1", relayHandle: null, relayUnsub: null, outboundBuffer: [] });
    manager.add("r2", { agentId: "a", userId: "u", unsub: null, keepalive: null, ws: {} as any, openTime: 0, instanceId: "inst-2", relayHandle: null, relayUnsub: null, outboundBuffer: [] });
    const found = manager.findByInstance("inst-1");
    expect(found?.wsId).toBe("r1");
  });
});
```

Run: `bun test src/__tests__/relay-connection-manager.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 2: Implement RelayConnectionManager**

Create `src/transport/relay/connection-manager.ts`:

```typescript
import type { WsConnection } from "../ws-types";
import type { EngineRelayHandle } from "@mothership/plugin-sdk";

export interface RelayConnectionEntry {
  agentId: string;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WsConnection;
  openTime: number;
  instanceId: string | null;
  relayHandle: EngineRelayHandle | null;
  relayUnsub: (() => void) | null;
  outboundBuffer: Record<string, unknown>[];
}

export interface ManagedConnection extends RelayConnectionEntry {
  wsId: string;
}

export class RelayConnectionManager {
  private connections = new Map<string, RelayConnectionEntry>();

  add(wsId: string, entry: RelayConnectionEntry): void {
    this.connections.set(wsId, entry);
  }

  get(wsId: string): RelayConnectionEntry | undefined {
    return this.connections.get(wsId);
  }

  remove(wsId: string): void {
    const entry = this.connections.get(wsId);
    if (!entry) return;
    if (entry.keepalive) clearInterval(entry.keepalive);
    if (entry.unsub) entry.unsub();
    if (entry.relayUnsub) entry.relayUnsub();
    if (entry.relayHandle) {
      try { entry.relayHandle.close(); } catch {}
    }
    this.connections.delete(wsId);
  }

  findByInstance(instanceId: string): ManagedConnection | undefined {
    for (const [wsId, entry] of this.connections) {
      if (entry.instanceId === instanceId) return { wsId, ...entry };
    }
    return undefined;
  }

  findByAgentId(agentId: string): ManagedConnection[] {
    const results: ManagedConnection[] = [];
    for (const [wsId, entry] of this.connections) {
      if (entry.agentId === agentId) results.push({ wsId, ...entry });
    }
    return results;
  }

  clearAll(): void {
    for (const wsId of [...this.connections.keys()]) {
      this.remove(wsId);
    }
  }

  get size(): number {
    return this.connections.size;
  }
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test src/__tests__/relay-connection-manager.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/transport/relay/connection-manager.ts src/__tests__/relay-connection-manager.test.ts
git commit -m "feat: add RelayConnectionManager for relay connection lifecycle"
```

---

### Task 2: Create RelayMessageRouter

**Files:**
- Create: `src/transport/relay/message-router.ts`
- Create: `src/__tests__/relay-message-router.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/relay-message-router.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
// 测试消息路由：keep_alive 拦截、buffer 队列、消息转发

describe("RelayMessageRouter", () => {
  test("shouldInterceptOutbound returns true for keep_alive", () => {
    const { shouldInterceptOutbound } = require("../transport/relay/message-router");
    expect(shouldInterceptOutbound({ type: "keep_alive" })).toBe(true);
    expect(shouldInterceptOutbound({ type: "user", content: "hello" })).toBe(false);
  });

  test("shouldInterceptInbound returns true for keep_alive", () => {
    const { shouldInterceptInbound } = require("../transport/relay/message-router");
    expect(shouldInterceptInbound({ type: "keep_alive" })).toBe(true);
    expect(shouldInterceptInbound({ type: "assistant", content: "hi" })).toBe(false);
  });

  test("bufferOutbound adds message to buffer", () => {
    const { createOutboundBuffer } = require("../transport/relay/message-router");
    const buffer = createOutboundBuffer();
    const msg = { type: "user", content: "hello" };
    buffer.push(msg);
    expect(buffer.length).toBe(1);
    expect(buffer[0]).toEqual(msg);
  });

  test("flushBuffer returns and clears buffered messages", () => {
    const { createOutboundBuffer, flushBuffer } = require("../transport/relay/message-router");
    const buffer = createOutboundBuffer();
    buffer.push({ type: "connect" });
    buffer.push({ type: "user", content: "hi" });
    const flushed = flushBuffer(buffer);
    expect(flushed.length).toBe(2);
    expect(buffer.length).toBe(0);
  });

  test("filterConnectFromFlush skips connect messages", () => {
    const { filterConnectFromFlush } = require("../transport/relay/message-router");
    const msgs = [
      { type: "connect" },
      { type: "user", content: "hi" },
      { type: "connect" },
      { type: "user", content: "bye" },
    ];
    const filtered = filterConnectFromFlush(msgs);
    expect(filtered.length).toBe(2);
    expect(filtered[0].type).toBe("user");
    expect(filtered[1].type).toBe("user");
  });
});
```

Run: `bun test src/__tests__/relay-message-router.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 2: Implement RelayMessageRouter**

Create `src/transport/relay/message-router.ts`:

```typescript
/** Whether an outbound message should be intercepted (not forwarded to frontend) */
export function shouldInterceptOutbound(message: Record<string, unknown>): boolean {
  return message.type === "keep_alive";
}

/** Whether an inbound message should be intercepted (not forwarded to frontend) */
export function shouldInterceptInbound(message: Record<string, unknown>): boolean {
  return message.type === "keep_alive";
}

/** Create a new outbound buffer */
export function createOutboundBuffer(): Record<string, unknown>[] {
  return [];
}

/** Flush all messages from a buffer, returning them and clearing the buffer */
export function flushBuffer(buffer: Record<string, unknown>[]): Record<string, unknown>[] {
  return buffer.splice(0);
}

/** Filter out "connect" messages from a flushed batch (relay handle auto-connects) */
export function filterConnectFromFlush(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.filter((msg) => msg.type !== "connect");
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test src/__tests__/relay-message-router.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/transport/relay/message-router.ts src/__tests__/relay-message-router.test.ts
git commit -m "feat: add RelayMessageRouter for message filtering and buffering"
```

---

### Task 3: Create main relay handler that uses the new modules

**Files:**
- Create: `src/transport/relay/relay-handler.ts`
- Create: `src/transport/relay/index.ts`
- Delete: `src/transport/acp-relay-handler.ts`

- [ ] **Step 1: Create relay-handler.ts**

Create `src/transport/relay/relay-handler.ts` by refactoring `src/transport/acp-relay-handler.ts`:

1. Import `RelayConnectionManager` from `./connection-manager`
2. Import message routing functions from `./message-router`
3. Replace the module-level `relayConnections` Map with a `RelayConnectionManager` instance
4. Keep `handleRelayOpen`, `handleRelayMessage`, `handleRelayClose`, `handleRelayShutdown` as the public API
5. Use the manager for all connection add/remove/get operations
6. Use message router for keep_alive interception and buffer flush

The key structural change: replace bare Map operations with manager method calls:

| Before | After |
|--------|-------|
| `relayConnections.get(wsId)` | `manager.get(wsId)` |
| `relayConnections.set(wsId, entry)` | `manager.add(wsId, entry)` |
| `relayConnections.delete(wsId)` | `manager.remove(wsId)` |
| Inline keep_alive check | `shouldInterceptInbound(msg)` |
| Inline buffer flush | `flushBuffer()` + `filterConnectFromFlush()` |

- [ ] **Step 2: Create barrel index.ts**

Create `src/transport/relay/index.ts`:

```typescript
export { handleRelayOpen, handleRelayMessage, handleRelayClose, handleRelayShutdown } from "./relay-handler";
export { RelayConnectionManager } from "./connection-manager";
```

- [ ] **Step 3: Update all importers of acp-relay-handler**

Run: `grep -rn "acp-relay-handler" src/`

For each file found (likely `src/index.ts` and `src/routes/acp/*.ts`):
1. Change `from "../transport/acp-relay-handler"` → `from "../transport/relay"`
2. The exported function names (`handleRelayOpen`, `handleRelayMessage`, `handleRelayClose`) remain the same, so only the import path changes.

- [ ] **Step 4: Delete old file**

Delete `src/transport/acp-relay-handler.ts` once all imports are migrated.

- [ ] **Step 5: Verify build + all tests**

Run: `bun run typecheck && bun test src/__tests__/`

- [ ] **Step 6: Commit**

```bash
git add src/transport/relay/ src/transport/acp-relay-handler.ts src/index.ts
git commit -m "refactor: split acp-relay-handler into relay/ directory with ConnectionManager + MessageRouter"
```

---

### Task 4: Final verification

**Files:**
- None (verification only)

- [ ] **Step 1: Full typecheck + test suite + build**

Run: `bun run typecheck && bun test src/__tests__/ && bun run build:web`

Expected: All pass

- [ ] **Step 2: Verify the old file is fully removed**

Run: `test -f src/transport/acp-relay-handler.ts && echo "STILL EXISTS" || echo "REMOVED"`

Expected: "REMOVED"

- [ ] **Step 3: Verify no imports reference old path**

Run: `grep -rn "acp-relay-handler" src/`

Expected: No results
