# In-Memory Store Type Safety Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all in-memory Map state into typed store modules with explicit interfaces, eliminating `Record<string, unknown>` patterns and inline interface definitions scattered across transport/service layers.
**Architecture:** Consolidate per-domain in-memory state into dedicated store modules under `src/store/`. Each store module exports a typed interface for its entries, a class encapsulating the Map, and a singleton instance. Transport handlers and services depend on the store interfaces rather than managing their own Maps directly.
**Tech Stack:** TypeScript strict mode, Bun test runner, Drizzle ORM (for PG-backed repos that remain unchanged)

---

## Current State Analysis

The codebase has **no single `src/store.ts`** file. In-memory state is spread across 8+ files:

| Module | Map Type | Typed? | Key Type | Value Type |
|--------|----------|--------|----------|------------|
| `repositories/session.ts` | `Map<string, SessionRecord>` | Yes | ✅ | ✅ |
| `repositories/session-worker.ts` | `Map<string, SessionWorkerRecord>` | Yes | ✅ | ✅ |
| `repositories/token.ts` | `Map<string, TokenRecord>` | Yes | ✅ | ✅ |
| `repositories/work-item.ts` | `Map<string, WorkItemRecord>` | Yes | ✅ | ✅ |
| `transport/acp-ws-handler.ts` | `Map<string, AcpConnectionEntry>` | Inline | ✅ | ⚠️ inline |
| `transport/relay/connection-manager.ts` | `Map<string, RelayConnectionEntry>` | Inline | ✅ | ⚠️ inline |
| `transport/ws-handler.ts` | `Map<string, CleanupEntry>` | Inline | ✅ | ⚠️ inline |
| `transport/event-bus.ts` | `Map<string, EventBus>` | Yes | ✅ | ✅ |
| `services/instance.ts` | `Map<string, InstanceSupplement>` + `Map<string, number>` | Inline | ✅ | ⚠️ inline |
| `services/scheduler.ts` | `Map<string, ScheduledJob>` | Inline | ✅ | ⚠️ inline |
| `services/workflow/index.ts` | `Map<string, WorkflowEngine>` | External | ✅ | ✅ |
| `services/cache.ts` | `Map<string, Keyv>` | External | ✅ | ✅ |
| `plugins/rate-limit.ts` | `Map<string, RateLimitEntry>` | Inline | ✅ | ⚠️ inline |

**Key finding:** The repository layer is already well-typed. The gaps are:
1. **Inline interfaces** in transport handlers and services that should be extracted to `src/types/` or dedicated store modules
2. **No centralized store barrel** — each module manages its own Map lifecycle independently
3. **`Record<string, unknown>` in `SessionWorkerRecord.externalMetadata` and `requiresActionDetails`** — these could use more specific types where the shape is known
4. **Missing reset/cleanup functions** for transport-layer Maps (testability gap)

## Scope Decisions

**In scope:**
- Extract inline interfaces from transport/service layers into `src/types/`
- Create `src/store/` barrel with typed store exports
- Add reset functions for all in-memory Maps (testability)
- Tighten `SessionWorkerRecord` field types where consumers define the shape
- Add status string literal unions where applicable

**Out of scope:**
- `services/cache.ts` (Keyv external library, already typed)
- `services/workflow/index.ts` (WorkflowEngine external type)
- `repositories/*.ts` (already well-typed, no changes needed)
- Database schema changes

## File Structure

```
src/types/
  store.ts                    # NEW — all store entry interfaces extracted from transport/service
  environment.ts              # NEW — environment status/status literal unions
  instance.ts                 # NEW — instance status literal unions
src/store/
  acp-connections.ts          # NEW — AcpConnectionStore class + singleton
  relay-connections.ts        # NEW — RelayConnectionStore class + singleton (wraps RelayConnectionManager)
  ws-sessions.ts              # NEW — WsSessionStore class + singleton
  event-buses.ts              # NEW — EventBusStore class + singleton (wraps event-bus.ts Maps)
  instance-supplements.ts     # NEW — InstanceSupplementStore class + singleton
  scheduler-jobs.ts           # NEW — SchedulerJobStore class + singleton
  rate-limit.ts               # NEW — RateLimitStore class + singleton
  index.ts                    # NEW — barrel re-export of all stores + resetAll()
src/transport/
  acp-ws-handler.ts           # MODIFY — use AcpConnectionStore instead of inline Map
  relay/connection-manager.ts # MODIFY — use types from src/types/store.ts
  relay/relay-handler.ts      # MODIFY — use RelayConnectionStore
  ws-handler.ts               # MODIFY — use WsSessionStore
  event-bus.ts                # MODIFY — use EventBusStore
src/services/
  instance.ts                 # MODIFY — use InstanceSupplementStore
  scheduler.ts                # MODIFY — use SchedulerJobStore
src/plugins/
  rate-limit.ts               # MODIFY — use RateLimitStore
src/__tests__/
  store-types.test.ts         # NEW — verify all store types and reset functions
```

## Tasks

### Task 1: Create shared type definitions
**Files:**
- Create: `src/types/store.ts`
- Create: `src/types/environment.ts`
- Create: `src/types/instance.ts`

- [ ] **Step 1: Create `src/types/environment.ts` — environment status and worker type unions**

```typescript
// src/types/environment.ts
/** Environment status values used across repositories, services, and transport */
export type EnvironmentStatus =
  | "active"
  | "idle"
  | "disconnected"
  | "deregistered";

/** Worker type discriminant for environment records */
export type WorkerType = "acp" | "opencode" | "bridge";
```

- [ ] **Step 2: Create `src/types/instance.ts` — instance status unions**

```typescript
// src/types/instance.ts
/** Instance lifecycle status, mapped from core RuntimeInstanceStatus */
export type InstanceStatus =
  | "starting"
  | "running"
  | "stopped"
  | "error";
```

- [ ] **Step 3: Create `src/types/store.ts` — all store entry interfaces**

Extract inline interfaces from transport handlers and services into a single types file. This file defines the shapes of all in-memory Map entries.

```typescript
// src/types/store.ts
import type { EngineRelayHandle } from "@mothership/plugin-sdk";
import type { InstanceStatus } from "./instance";
import type { WsConnection } from "../transport/ws-types";

// ────────────────────────────────────────────
// ACP WebSocket Connection Store
// Extracted from: src/transport/acp-ws-handler.ts
// ────────────────────────────────────────────

/** Per-connection state for ACP WebSocket connections (`/acp/ws`) */
export interface AcpConnectionEntry {
  /** Bound agent ID (set after register/identify) */
  agentId: string | null;
  /** Pre-bound environment ID (for spawned instances) */
  boundEnvId: string | null;
  /** Authenticated user ID */
  userId: string;
  /** EventBus unsubscribe function */
  unsub: (() => void) | null;
  /** Server-side keepalive interval handle */
  keepalive: ReturnType<typeof setInterval> | null;
  /** Underlying WebSocket connection */
  ws: WsConnection;
  /** Connection open timestamp (epoch ms) */
  openTime: number;
  /** Last client activity timestamp (epoch ms) */
  lastClientActivity: number;
  /** Agent capabilities reported during registration */
  capabilities: Record<string, unknown> | null;
}

// ────────────────────────────────────────────
// Relay Connection Store
// Extracted from: src/transport/relay/connection-manager.ts
// ────────────────────────────────────────────

/** Per-connection state for frontend relay connections (`/acp/relay/:agentId`) */
export interface RelayConnectionEntry {
  /** Target agent/environment ID */
  agentId: string;
  /** Authenticated user ID */
  userId: string;
  /** EventBus unsubscribe function */
  unsub: (() => void) | null;
  /** Server-side keepalive interval handle */
  keepalive: ReturnType<typeof setInterval> | null;
  /** Underlying WebSocket connection */
  ws: WsConnection;
  /** Connection open timestamp (epoch ms) */
  openTime: number;
  /** Spawned instance ID (instance mode) */
  instanceId: string | null;
  /** Core relay handle (instance mode) */
  relayHandle: EngineRelayHandle | null;
  /** Core relay onMessage unsubscribe */
  relayUnsub: (() => void) | null;
  /** Buffered outbound messages waiting for relay handle */
  outboundBuffer: Record<string, unknown>[];
}

/** RelayConnectionEntry + wsId for managed connections */
export interface ManagedConnection extends RelayConnectionEntry {
  wsId: string;
}

// ────────────────────────────────────────────
// WS Session Store
// Extracted from: src/transport/ws-handler.ts
// ────────────────────────────────────────────

/** Per-session cleanup state for legacy bridge WebSocket connections */
export interface WsSessionCleanupEntry {
  /** EventBus unsubscribe function */
  unsub: () => void;
  /** Server-side keepalive interval handle */
  keepalive: ReturnType<typeof setInterval>;
  /** Underlying WebSocket connection */
  ws: WsConnection;
  /** Connection open timestamp (epoch ms) */
  openTime: number;
  /** Last client activity timestamp (epoch ms) */
  lastClientActivity: number;
}

// ────────────────────────────────────────────
// Instance Supplement Store
// Extracted from: src/services/instance.ts
// ────────────────────────────────────────────

/** RCS business fields not tracked by core RuntimeInstanceSnapshot */
export interface InstanceSupplement {
  /** Owning user ID */
  userId: string;
  /** Parent environment ID */
  environmentId: string;
  /** Monotonic instance number within the environment */
  instanceNumber: number;
  /** Owning organization ID */
  organizationId: string;
}

// ────────────────────────────────────────────
// Scheduler Job Store
// Extracted from: src/services/scheduler.ts
// ────────────────────────────────────────────

/** Active scheduled job entry */
export interface ScheduledJobEntry {
  /** Scheduled task database ID */
  taskId: string;
  /** node-schedule Job handle */
  job: import("node-schedule").Job;
}

// ────────────────────────────────────────────
// Rate Limit Store
// Extracted from: src/plugins/rate-limit.ts
// ────────────────────────────────────────────

/** Per-IP rate limit sliding window entry */
export interface RateLimitEntry {
  /** Request count in current window */
  count: number;
  /** Window reset timestamp (epoch ms) */
  resetAt: number;
}
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
```

---

### Task 2: Create store modules (typed Map wrappers)
**Files:**
- Create: `src/store/acp-connections.ts`
- Create: `src/store/relay-connections.ts`
- Create: `src/store/ws-sessions.ts`
- Create: `src/store/event-buses.ts`
- Create: `src/store/instance-supplements.ts`
- Create: `src/store/scheduler-jobs.ts`
- Create: `src/store/rate-limit.ts`
- Create: `src/store/index.ts`

- [ ] **Step 1: Create `src/store/acp-connections.ts`**

Wraps the `Map<string, AcpConnectionEntry>` from `acp-ws-handler.ts` into a typed store class.

```typescript
// src/store/acp-connections.ts
import type { AcpConnectionEntry } from "../types/store";

/**
 * In-memory store for ACP WebSocket connection state.
 * Keyed by wsId (unique per WebSocket connection).
 */
export class AcpConnectionStore {
  private readonly connections = new Map<string, AcpConnectionEntry>();

  /** Get connection entry by wsId */
  get(wsId: string): AcpConnectionEntry | undefined {
    return this.connections.get(wsId);
  }

  /** Set connection entry */
  set(wsId: string, entry: AcpConnectionEntry): void {
    this.connections.set(wsId, entry);
  }

  /** Delete connection entry by wsId */
  delete(wsId: string): boolean {
    return this.connections.delete(wsId);
  }

  /** Iterate all entries for shutdown scanning */
  entries(): IterableIterator<[string, AcpConnectionEntry]> {
    return this.connections.entries();
  }

  /** Find an active ACP connection by agent ID */
  findByAgentId(agentId: string): AcpConnectionEntry | undefined {
    for (const entry of this.connections.values()) {
      if (entry.agentId === agentId && entry.ws.readyState === 1) {
        return entry;
      }
    }
    return undefined;
  }

  /** Number of active connections */
  get size(): number {
    return this.connections.size;
  }

  /** Clear all connections (graceful shutdown) */
  clear(): void {
    this.connections.clear();
  }
}

/** Global singleton */
export const acpConnectionStore = new AcpConnectionStore();
```

- [ ] **Step 2: Create `src/store/relay-connections.ts`**

Adapts the existing `RelayConnectionManager` to use the shared types from `src/types/store.ts`.

```typescript
// src/store/relay-connections.ts
import type { ManagedConnection, RelayConnectionEntry } from "../types/store";

/**
 * In-memory store for relay WebSocket connection state.
 * Keyed by relayWsId (unique per relay connection).
 */
export class RelayConnectionStore {
  private readonly connections = new Map<string, RelayConnectionEntry>();
  private shuttingDown = false;

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

  hasOtherRelayForInstance(instanceId: string, excludeWsId?: string): boolean {
    for (const [wsId, entry] of this.connections) {
      if (entry.instanceId === instanceId && wsId !== excludeWsId) return true;
    }
    return false;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  set isShuttingDown(value: boolean) {
    this.shuttingDown = value;
  }

  get size(): number {
    return this.connections.size;
  }

  entries(): IterableIterator<[string, RelayConnectionEntry]> {
    return this.connections.entries();
  }

  clear(): void {
    this.connections.clear();
  }
}

/** Global singleton */
export const relayConnectionStore = new RelayConnectionStore();
```

- [ ] **Step 3: Create `src/store/ws-sessions.ts`**

```typescript
// src/store/ws-sessions.ts
import type { WsConnection } from "../transport/ws-types";
import type { WsSessionCleanupEntry } from "../types/store";

/**
 * In-memory store for legacy bridge WebSocket session cleanup state.
 * Keyed by sessionId (one WS per session).
 */
export class WsSessionStore {
  private readonly sessions = new Map<string, WsSessionCleanupEntry>();
  private readonly activeConnections = new Set<WsConnection>();

  /** Get cleanup entry by sessionId */
  get(sessionId: string): WsSessionCleanupEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /** Set cleanup entry for a session */
  set(sessionId: string, entry: WsSessionCleanupEntry): void {
    this.sessions.set(sessionId, entry);
  }

  /** Delete cleanup entry by sessionId */
  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Track an active WebSocket connection */
  addConnection(ws: WsConnection): void {
    this.activeConnections.add(ws);
  }

  /** Remove a tracked WebSocket connection */
  removeConnection(ws: WsConnection): void {
    this.activeConnections.delete(ws);
  }

  /** Replace existing connection entry (returns old entry if any) */
  replace(sessionId: string, entry: WsSessionCleanupEntry): WsSessionCleanupEntry | undefined {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.activeConnections.delete(existing.ws);
    }
    this.sessions.set(sessionId, entry);
    return existing;
  }

  /** Number of tracked sessions */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Number of active connections */
  get connectionCount(): number {
    return this.activeConnections.size;
  }

  /** Clear all sessions and connections (graceful shutdown) */
  clear(): void {
    this.sessions.clear();
    this.activeConnections.clear();
  }

  /** Iterate all session entries for shutdown */
  entries(): IterableIterator<[string, WsSessionCleanupEntry]> {
    return this.sessions.entries();
  }

  /** Iterate all active connections */
  connections(): Set<WsConnection> {
    return this.activeConnections;
  }
}

/** Global singleton */
export const wsSessionStore = new WsSessionStore();
```

- [ ] **Step 4: Create `src/store/event-buses.ts`**

```typescript
// src/store/event-buses.ts
import type { EventBus } from "../transport/event-bus";

/**
 * In-memory store for per-session and per-agent EventBus instances.
 * Two separate Maps: session buses (legacy WS) and ACP buses (agent relay).
 */
export class EventBusStore {
  private readonly sessionBuses = new Map<string, EventBus>();
  private readonly acpBuses = new Map<string, EventBus>();

  /** Get or create a session EventBus */
  getOrCreateSession(sessionId: string, factory: () => EventBus): EventBus {
    let bus = this.sessionBuses.get(sessionId);
    if (!bus) {
      bus = factory();
      this.sessionBuses.set(sessionId, bus);
    }
    return bus;
  }

  /** Get a session EventBus without creating */
  getSession(sessionId: string): EventBus | undefined {
    return this.sessionBuses.get(sessionId);
  }

  /** Remove and close a session EventBus */
  removeSession(sessionId: string): void {
    const bus = this.sessionBuses.get(sessionId);
    if (bus) {
      bus.close();
      this.sessionBuses.delete(sessionId);
    }
  }

  /** Get all session buses */
  allSessionBuses(): Map<string, EventBus> {
    return this.sessionBuses;
  }

  /** Get or create an ACP EventBus */
  getOrCreateAcp(channelGroupId: string, factory: () => EventBus): EventBus {
    let bus = this.acpBuses.get(channelGroupId);
    if (!bus) {
      bus = factory();
      this.acpBuses.set(channelGroupId, bus);
    }
    return bus;
  }

  /** Get an ACP EventBus without creating */
  getAcp(channelGroupId: string): EventBus | undefined {
    return this.acpBuses.get(channelGroupId);
  }

  /** Remove and close an ACP EventBus */
  removeAcp(channelGroupId: string): void {
    const bus = this.acpBuses.get(channelGroupId);
    if (bus) {
      bus.close();
      this.acpBuses.delete(channelGroupId);
    }
  }

  /** Clear all buses (test/shutdown) */
  clear(): void {
    for (const bus of this.sessionBuses.values()) bus.close();
    for (const bus of this.acpBuses.values()) bus.close();
    this.sessionBuses.clear();
    this.acpBuses.clear();
  }
}

/** Global singleton */
export const eventBusStore = new EventBusStore();
```

- [ ] **Step 5: Create `src/store/instance-supplements.ts`**

```typescript
// src/store/instance-supplements.ts
import type { InstanceSupplement } from "../types/store";

/**
 * In-memory store for RCS business fields not tracked by core RuntimeInstanceSnapshot.
 * Keyed by instanceId.
 */
export class InstanceSupplementStore {
  private readonly supplements = new Map<string, InstanceSupplement>();
  private readonly envCounters = new Map<string, number>();

  /** Get supplement by instanceId */
  get(instanceId: string): InstanceSupplement | undefined {
    return this.supplements.get(instanceId);
  }

  /** Set supplement for an instance */
  set(instanceId: string, supplement: InstanceSupplement): void {
    this.supplements.set(instanceId, supplement);
  }

  /** Delete supplement by instanceId */
  delete(instanceId: string): boolean {
    return this.supplements.delete(instanceId);
  }

  /** Get and increment the next instance number for an environment */
  nextInstanceNumber(environmentId: string): number {
    const current = this.envCounters.get(environmentId) ?? 0;
    const next = current + 1;
    this.envCounters.set(environmentId, next);
    return next;
  }

  /** Remove counter for an environment if no active instances remain */
  deleteCounterIfEmpty(environmentId: string, hasActiveInstances: boolean): void {
    if (!hasActiveInstances) {
      this.envCounters.delete(environmentId);
    }
  }

  /** Number of supplements (active instances) */
  get size(): number {
    return this.supplements.size;
  }

  /** Clear all supplements and counters */
  clear(): void {
    this.supplements.clear();
    this.envCounters.clear();
  }
}

/** Global singleton */
export const instanceSupplementStore = new InstanceSupplementStore();
```

- [ ] **Step 6: Create `src/store/scheduler-jobs.ts`**

```typescript
// src/store/scheduler-jobs.ts
import type { Job } from "node-schedule";
import type { ScheduledJobEntry } from "../types/store";

/**
 * In-memory store for active scheduled jobs.
 * Keyed by taskId (database ID of the scheduled task).
 */
export class SchedulerJobStore {
  private readonly jobs = new Map<string, ScheduledJobEntry>();
  private readonly runningTasks = new Set<string>();

  /** Get job entry by taskId */
  get(taskId: string): ScheduledJobEntry | undefined {
    return this.jobs.get(taskId);
  }

  /** Set job entry */
  set(taskId: string, entry: ScheduledJobEntry): void {
    this.jobs.set(taskId, entry);
  }

  /** Delete job entry by taskId */
  delete(taskId: string): boolean {
    return this.jobs.delete(taskId);
  }

  /** Check if a task is currently running */
  isRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId);
  }

  /** Mark a task as running */
  markRunning(taskId: string): void {
    this.runningTasks.add(taskId);
  }

  /** Unmark a task as running */
  unmarkRunning(taskId: string): void {
    this.runningTasks.delete(taskId);
  }

  /** Number of scheduled jobs */
  get jobCount(): number {
    return this.jobs.size;
  }

  /** Clear all jobs and running markers */
  clear(): void {
    for (const entry of this.jobs.values()) {
      entry.job.cancel();
    }
    this.jobs.clear();
    this.runningTasks.clear();
  }
}

/** Global singleton */
export const schedulerJobStore = new SchedulerJobStore();
```

- [ ] **Step 7: Create `src/store/rate-limit.ts`**

```typescript
// src/store/rate-limit.ts
import type { RateLimitEntry } from "../types/store";

/**
 * In-memory store for per-IP rate limit entries.
 * Keyed by client IP (from x-forwarded-for or x-real-ip).
 */
export class RateLimitStore {
  private readonly entries = new Map<string, RateLimitEntry>();

  /** Get rate limit entry for a client */
  get(clientId: string): RateLimitEntry | undefined {
    return this.entries.get(clientId);
  }

  /** Set rate limit entry for a client */
  set(clientId: string, entry: RateLimitEntry): void {
    this.entries.set(clientId, entry);
  }

  /** Evict expired entries older than the given epoch ms */
  evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now > entry.resetAt) this.entries.delete(key);
    }
  }

  /** Clear all entries */
  clear(): void {
    this.entries.clear();
  }
}

/** Global singleton */
export const rateLimitStore = new RateLimitStore();
```

- [ ] **Step 8: Create `src/store/index.ts` — barrel re-export + resetAll**

```typescript
// src/store/index.ts

// ── Store singletons ──
export { acpConnectionStore, AcpConnectionStore } from "./acp-connections";
export { eventBusStore, EventBusStore } from "./event-buses";
export { instanceSupplementStore, InstanceSupplementStore } from "./instance-supplements";
export { rateLimitStore, RateLimitStore } from "./rate-limit";
export { relayConnectionStore, RelayConnectionStore } from "./relay-connections";
export { schedulerJobStore, SchedulerJobStore } from "./scheduler-jobs";
export { wsSessionStore, WsSessionStore } from "./ws-sessions";

/**
 * Reset all in-memory stores for testing.
 * Does NOT reset repository stores (session, token, work-item, session-worker)
 * which have their own resetAllRepos() in src/repositories/index.ts.
 */
export function resetAllStores(): void {
  acpConnectionStore.clear();
  relayConnectionStore.clear();
  wsSessionStore.clear();
  eventBusStore.clear();
  instanceSupplementStore.clear();
  schedulerJobStore.clear();
  rateLimitStore.clear();
}
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
```

---

### Task 3: Migrate `acp-ws-handler.ts` to use `AcpConnectionStore`
**Files:**
- Modify: `src/transport/acp-ws-handler.ts`

- [ ] **Step 1: Replace inline `Map<string, AcpConnectionEntry>` with `acpConnectionStore`**

The `AcpConnectionEntry` interface moves to `src/types/store.ts` (already done in Task 1). The `connections` Map is replaced by `acpConnectionStore` from `src/store/acp-connections.ts`.

Key changes in `src/transport/acp-ws-handler.ts`:

1. Remove the inline `AcpConnectionEntry` interface definition
2. Remove the `const connections = new Map<string, AcpConnectionEntry>()` declaration
3. Import `AcpConnectionEntry` from `../types/store` and `acpConnectionStore` from `../store`
4. Replace all `connections.get(wsId)` with `acpConnectionStore.get(wsId)`
5. Replace all `connections.set(wsId, ...)` with `acpConnectionStore.set(wsId, ...)`
6. Replace all `connections.delete(wsId)` with `acpConnectionStore.delete(wsId)`
7. Replace `findAcpConnectionByAgentId` with `acpConnectionStore.findByAgentId`
8. Replace `connections.size` with `acpConnectionStore.size`
9. Replace `connections.clear()` with `acpConnectionStore.clear()`
10. Update `connections.values()` iteration in `findAcpConnectionByAgentId` to use `acpConnectionStore.entries()`

```typescript
// src/transport/acp-ws-handler.ts
// After migration — key diff sections:

import type { AcpConnectionEntry } from "../types/store";
import { acpConnectionStore } from "../store";

// REMOVED: interface AcpConnectionEntry { ... }
// REMOVED: const connections = new Map<string, AcpConnectionEntry>();

// In handleAcpWsOpen:
//   connections.set(wsId, { ... }) → acpConnectionStore.set(wsId, { ... })
//   connections.get(wsId) → acpConnectionStore.get(wsId)

// In handleRegister:
//   connections.get(wsId) → acpConnectionStore.get(wsId)

// In handleIdentify:
//   connections.get(wsId) → acpConnectionStore.get(wsId)

// In handleAcpWsMessage:
//   connections.get(wsId) → acpConnectionStore.get(wsId)

// In handleAcpWsClose:
//   connections.get(wsId) → acpConnectionStore.get(wsId)
//   connections.delete(wsId) → acpConnectionStore.delete(wsId)

// findAcpConnectionByAgentId now delegates to store:
export function findAcpConnectionByAgentId(agentId: string): AcpConnectionEntry | null {
  return acpConnectionStore.findByAgentId(agentId) ?? null;
}

// closeAllAcpConnections:
//   connections.size → acpConnectionStore.size
//   connections → acpConnectionStore.entries()
//   connections.clear() → acpConnectionStore.clear()
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
bun test src/__tests__/acp-register-combined-update.test.ts src/__tests__/acp-identify-parallel.test.ts src/__tests__/capabilities-coalescing.test.ts 2>&1 | tail -10
```

---

### Task 4: Migrate `relay/connection-manager.ts` to use `RelayConnectionStore`
**Files:**
- Modify: `src/transport/relay/connection-manager.ts`
- Modify: `src/transport/relay/relay-handler.ts`

- [ ] **Step 1: Replace `RelayConnectionManager` class with `RelayConnectionStore`**

The `relay/connection-manager.ts` currently defines `RelayConnectionEntry`, `ManagedConnection`, and the `RelayConnectionManager` class. After migration:

1. Move `RelayConnectionEntry` and `ManagedConnection` type definitions to `src/types/store.ts` (already done in Task 1)
2. Replace the `RelayConnectionManager` class with re-exports from `src/store/relay-connections.ts`
3. Keep `sendToRelayWs` utility function in `connection-manager.ts`

```typescript
// src/transport/relay/connection-manager.ts
// After migration:

import type { RelayConnectionEntry } from "../../types/store";
import { relayConnectionStore } from "../../store";
import type { WsConnection } from "../ws-types";

// Re-export types for backward compatibility
export type { RelayConnectionEntry } from "../../types/store";
export type { ManagedConnection } from "../../types/store";

// Re-export store singleton under the old name for backward compatibility
export { relayConnectionStore as manager } from "../../store";

/** Send a JSON message to relay WS */
export function sendToRelayWs(ws: WsConnection, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    const payload = JSON.stringify(msg);
    ws.send(payload);
  } catch (err) {
    // Log and ignore send errors
  }
}
```

- [ ] **Step 2: Update `relay-handler.ts` imports**

```typescript
// src/transport/relay/relay-handler.ts
// Key changes:

import type { RelayConnectionEntry } from "../../types/store";
import { relayConnectionStore as manager } from "./connection-manager";
import { sendToRelayWs } from "./connection-manager";

// All existing `manager.add()`, `manager.get()`, `manager.remove()` calls
// work unchanged because relayConnectionStore has the same API.
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
bun test src/__tests__/relay-connection-manager.test.ts src/__tests__/relay-message-router.test.ts 2>&1 | tail -10
```

---

### Task 5: Migrate `ws-handler.ts` to use `WsSessionStore`
**Files:**
- Modify: `src/transport/ws-handler.ts`

- [ ] **Step 1: Replace inline Maps with `wsSessionStore`**

```typescript
// src/transport/ws-handler.ts
// Key changes:

import type { WsSessionCleanupEntry } from "../types/store";
import { wsSessionStore } from "../store";

// REMOVED: interface CleanupEntry { ... }
// REMOVED: const cleanupBySession = new Map<string, CleanupEntry>();
// REMOVED: const activeConnections = new Set<WsConnection>();

// In handleWebSocketOpen:
//   activeConnections.add(ws) → wsSessionStore.addConnection(ws)
//   cleanupBySession.get(sessionId) → wsSessionStore.get(sessionId)
//   cleanupBySession.set(sessionId, { ... }) → wsSessionStore.set(sessionId, { ... })

// In handleWebSocketMessage:
//   cleanupBySession.get(sessionId) → wsSessionStore.get(sessionId)

// In handleWebSocketClose:
//   activeConnections.delete(ws) → wsSessionStore.removeConnection(ws)
//   cleanupBySession.get(sessionId) → wsSessionStore.get(sessionId)
//   cleanupBySession.delete(sessionId) → wsSessionStore.delete(sessionId)

// In closeAllConnections:
//   cleanupBySession → wsSessionStore.entries()
//   cleanupBySession.clear(); activeConnections.clear() → wsSessionStore.clear()
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
bun test src/__tests__/ws-handler.test.ts 2>&1 | tail -10
```

---

### Task 6: Migrate `event-bus.ts` to use `EventBusStore`
**Files:**
- Modify: `src/transport/event-bus.ts`

- [ ] **Step 1: Replace inline Maps with `eventBusStore`**

The `EventBus` class itself stays in `event-bus.ts` (it has its own logic). Only the global `buses` and `acpBuses` Maps migrate to the store.

```typescript
// src/transport/event-bus.ts
// Key changes:

import { eventBusStore } from "../store/event-buses";

// REMOVED: const buses = new Map<string, EventBus>();
// REMOVED: const acpBuses = new Map<string, EventBus>();

export function getEventBus(sessionId: string): EventBus {
  return eventBusStore.getOrCreateSession(sessionId, () => new EventBus());
}

export function removeEventBus(sessionId: string): void {
  eventBusStore.removeSession(sessionId);
}

export function getAllEventBuses(): Map<string, EventBus> {
  return eventBusStore.allSessionBuses();
}

export function getAcpEventBus(channelGroupId: string): EventBus {
  return eventBusStore.getOrCreateAcp(channelGroupId, () => new EventBus());
}

export function removeAcpEventBus(channelGroupId: string): void {
  eventBusStore.removeAcp(channelGroupId);
}
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
bun test src/__tests__/event-bus.test.ts 2>&1 | tail -10
```

---

### Task 7: Migrate `instance.ts` to use `InstanceSupplementStore`
**Files:**
- Modify: `src/services/instance.ts`

- [ ] **Step 1: Replace inline Maps with `instanceSupplementStore`**

```typescript
// src/services/instance.ts
// Key changes:

import type { InstanceSupplement } from "../types/store";
import { instanceSupplementStore } from "../store";

// REMOVED: interface InstanceSupplement { ... }
// REMOVED: const supplements = new Map<string, InstanceSupplement>();
// REMOVED: const envInstanceCounters = new Map<string, number>();
// REMOVED: function getNextInstanceNumber(environmentId: string): number { ... }

// In spawnInstanceFromEnvironment:
//   const instanceNumber = getNextInstanceNumber(environmentId)
//     → const instanceNumber = instanceSupplementStore.nextInstanceNumber(environmentId)
//   supplements.set(instanceId, supplement)
//     → instanceSupplementStore.set(instanceId, supplement)

// In filterInstances:
//   const sup = supplements.get(s.instanceId)
//     → const sup = instanceSupplementStore.get(s.instanceId)

// In getInstance:
//   supplements.get(id) → instanceSupplementStore.get(id)
//   supplements.delete(id) → instanceSupplementStore.delete(id)

// In stopInstance:
//   supplements.get(id) → instanceSupplementStore.get(id)
//   supplements.delete(id) → instanceSupplementStore.delete(id)
//   envInstanceCounters.delete(sup.environmentId)
//     → instanceSupplementStore.deleteCounterIfEmpty(sup.environmentId, remaining.length === 0)

// In stopAllInstances:
//   supplements.clear(); envInstanceCounters.clear()
//     → instanceSupplementStore.clear()
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
bun test src/__tests__/instance-service.test.ts src/__tests__/instance-supplement-cleanup.test.ts src/__tests__/instance-getinstance-cleanup.test.ts src/__tests__/group-instances-batch.test.ts 2>&1 | tail -10
```

---

### Task 8: Migrate `scheduler.ts` to use `SchedulerJobStore`
**Files:**
- Modify: `src/services/scheduler.ts`

- [ ] **Step 1: Replace inline Maps and Set with `schedulerJobStore`**

```typescript
// src/services/scheduler.ts
// Key changes:

import { schedulerJobStore } from "../store";

// REMOVED: interface ScheduledJob { ... }
// REMOVED: const runningTasks = new Set<string>();
// REMOVED: const activeJobs = new Map<string, ScheduledJob>();

// In executeTask:
//   runningTasks.has(taskId) → schedulerJobStore.isRunning(taskId)
//   runningTasks.add(taskId) → schedulerJobStore.markRunning(taskId)
//   runningTasks.delete(taskId) → schedulerJobStore.unmarkRunning(taskId)

// In scheduleTask:
//   activeJobs.set(task.id, { taskId: task.id, job })
//     → schedulerJobStore.set(task.id, { taskId: task.id, job })

// In unscheduleTask:
//   activeJobs.get(taskId) → schedulerJobStore.get(taskId)
//   activeJobs.delete(taskId) → schedulerJobStore.delete(taskId)

// In stopScheduler:
//   for loop + activeJobs.clear(); runningTasks.clear()
//     → schedulerJobStore.clear()
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
bun test src/__tests__/scheduler-invocation-date-guard.test.ts 2>&1 | tail -10
```

---

### Task 9: Migrate `rate-limit.ts` to use `RateLimitStore`
**Files:**
- Modify: `src/plugins/rate-limit.ts`

- [ ] **Step 1: Replace inline Map with `rateLimitStore`**

```typescript
// src/plugins/rate-limit.ts
// Key changes:

import { rateLimitStore } from "../store/rate-limit";

// REMOVED: interface RateLimitEntry { ... }
// REMOVED: const store = new Map<string, RateLimitEntry>();

// In rate limit check:
//   store.get(clientId) → rateLimitStore.get(clientId)
//   store.set(clientId, entry) → rateLimitStore.set(clientId, entry)

// In cleanup interval:
//   for (const [key, entry] of store) { ... store.delete(key) }
//     → rateLimitStore.evictExpired(Date.now())
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
```

---

### Task 10: Tighten `SessionWorkerRecord` field types
**Files:**
- Modify: `src/repositories/session-worker.ts`

- [ ] **Step 1: Replace `Record<string, unknown>` with more specific types where possible**

Search all consumers of `SessionWorkerRecord.externalMetadata` and `requiresActionDetails` to understand their actual shapes.

```bash
grep -rn "externalMetadata\|requiresActionDetails" src/ --include="*.ts" | head -20
```

If the fields are only set/read as opaque JSON blobs from ACP messages, keep `Record<string, unknown> | null` but add JSDoc:

```typescript
// src/repositories/session-worker.ts
export interface SessionWorkerRecord {
  sessionId: string;
  /** Worker status: "idle" | "running" | "requires_action" | "completed" | "error" | null */
  workerStatus: WorkerStatus | null;
  /** Opaque metadata from the ACP agent worker (tool info, model name, etc.) */
  externalMetadata: Record<string, unknown> | null;
  /** Details of a pending permission request (tool name, input, etc.) */
  requiresActionDetails: PermissionRequestDetails | null;
  lastHeartbeatAt: Date | null;
}
```

Define `WorkerStatus` and `PermissionRequestDetails` in `src/types/store.ts`:

```typescript
// Add to src/types/store.ts

/** Worker status values reported by ACP agent */
export type WorkerStatus =
  | "idle"
  | "running"
  | "requires_action"
  | "completed"
  | "error";

/** Shape of a pending permission request from ACP agent */
export interface PermissionRequestDetails {
  /** The tool name requesting permission */
  toolName?: string;
  /** The proposed tool input */
  input?: Record<string, unknown>;
  /** Unique request ID for matching response */
  requestId?: string;
}
```

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
```

---

### Task 11: Add comprehensive store types test
**Files:**
- Create: `src/__tests__/store-types.test.ts`

- [ ] **Step 1: Write test verifying all store modules work with typed data**

```typescript
// src/__tests__/store-types.test.ts
import { describe, expect, test } from "bun:test";
import { acpConnectionStore } from "../store/acp-connections";
import { relayConnectionStore } from "../store/relay-connections";
import { wsSessionStore } from "../store/ws-sessions";
import { eventBusStore } from "../store/event-buses";
import { instanceSupplementStore } from "../store/instance-supplements";
import { schedulerJobStore } from "../store/scheduler-jobs";
import { rateLimitStore } from "../store/rate-limit";
import { resetAllStores } from "../store";

describe("Store type safety", () => {
  // Verify store singletons are correctly typed
  test("AcpConnectionStore get/set/delete cycle", () => {
    const mockWs = { readyState: 1, send: () => {}, close: () => {} } as any;
    acpConnectionStore.set("ws-1", {
      agentId: null,
      boundEnvId: null,
      userId: "user-1",
      unsub: null,
      keepalive: null,
      ws: mockWs,
      openTime: Date.now(),
      lastClientActivity: Date.now(),
      capabilities: null,
    });

    const entry = acpConnectionStore.get("ws-1");
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe("user-1");
    expect(entry!.agentId).toBeNull();

    acpConnectionStore.delete("ws-1");
    expect(acpConnectionStore.get("ws-1")).toBeUndefined();
  });

  test("RelayConnectionStore get/set/remove cycle", () => {
    const mockWs = { readyState: 1, send: () => {}, close: () => {} } as any;
    relayConnectionStore.add("relay-1", {
      agentId: "agent-1",
      userId: "user-1",
      unsub: null,
      keepalive: null,
      ws: mockWs,
      openTime: Date.now(),
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });

    const entry = relayConnectionStore.get("relay-1");
    expect(entry).toBeDefined();
    expect(entry!.agentId).toBe("agent-1");

    relayConnectionStore.remove("relay-1");
    expect(relayConnectionStore.get("relay-1")).toBeUndefined();
  });

  test("InstanceSupplementStore counter management", () => {
    const num1 = instanceSupplementStore.nextInstanceNumber("env-1");
    const num2 = instanceSupplementStore.nextInstanceNumber("env-1");
    expect(num1).toBe(1);
    expect(num2).toBe(2);

    instanceSupplementStore.set("inst-1", {
      userId: "user-1",
      environmentId: "env-1",
      instanceNumber: 1,
      organizationId: "org-1",
    });
    expect(instanceSupplementStore.get("inst-1")).toBeDefined();
    expect(instanceSupplementStore.get("inst-1")!.organizationId).toBe("org-1");
  });

  test("RateLimitStore eviction", () => {
    rateLimitStore.set("ip-1", { count: 50, resetAt: Date.now() - 1000 });
    rateLimitStore.set("ip-2", { count: 10, resetAt: Date.now() + 60000 });

    rateLimitStore.evictExpired(Date.now());
    expect(rateLimitStore.get("ip-1")).toBeUndefined();
    expect(rateLimitStore.get("ip-2")).toBeDefined();
  });

  test("SchedulerJobStore running tracking", () => {
    expect(schedulerJobStore.isRunning("task-1")).toBe(false);
    schedulerJobStore.markRunning("task-1");
    expect(schedulerJobStore.isRunning("task-1")).toBe(true);
    schedulerJobStore.unmarkRunning("task-1");
    expect(schedulerJobStore.isRunning("task-1")).toBe(false);
  });

  test("resetAllStores clears all stores", () => {
    rateLimitStore.set("ip-x", { count: 1, resetAt: Date.now() + 60000 });
    instanceSupplementStore.set("inst-x", {
      userId: "u",
      environmentId: "e",
      instanceNumber: 1,
      organizationId: "o",
    });

    resetAllStores();

    expect(rateLimitStore.get("ip-x")).toBeUndefined();
    expect(instanceSupplementStore.get("inst-x")).toBeUndefined();
  });
});
```

**Verification:**
```bash
bun test src/__tests__/store-types.test.ts 2>&1 | tail -20
```

---

### Task 12: Update `src/repositories/index.ts` to reference store reset
**Files:**
- Modify: `src/repositories/index.ts`

- [ ] **Step 1: Add store reset to the test helper**

```typescript
// Add to src/repositories/index.ts

import { resetAllStores } from "../store";

/** Reset all in-memory state (repositories + stores). Test-only. */
export function resetAll(): void {
  resetAllRepos();
  resetAllStores();
}
```

This allows tests to call `resetAll()` instead of remembering both `resetAllRepos()` and `resetAllStores()`.

**Verification:**
```bash
bun run typecheck 2>&1 | head -20
bun run precheck 2>&1 | tail -5
```

---

### Task 13: Final validation — run all tests
**Files:**
- No new files

- [ ] **Step 1: Run full typecheck + lint + all tests**

```bash
bun run precheck
bun test src/__tests__/ 2>&1 | tail -20
```

All existing tests must pass with 0 failures. The store type changes are purely structural (extracting interfaces and wrapping Maps in classes) and should not change any runtime behavior.
