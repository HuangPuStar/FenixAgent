// packages/acp-server/src/chat-writer.ts
import * as Y from "yjs";
import type { AgentInfo, ConnectionStatus, PermissionRequest, SessionSummary } from "./types";

export function setConnectionStatus(ydoc: Y.Doc, status: ConnectionStatus): void {
  ydoc.transact(() => {
    const conn = ydoc.getMap("connection");
    conn.set("status", status.status);
    conn.set("since", status.since);
  });
}

export function setAgentInfo(ydoc: Y.Doc, info: AgentInfo): void {
  ydoc.transact(() => {
    const map = ydoc.getMap("agentInfo");
    map.set("id", info.id);
    map.set("name", info.name);
    if (info.avatar) map.set("avatar", info.avatar);
    if (info.model) {
      const modelMap = new Y.Map<unknown>();
      modelMap.set("id", info.model.id);
      modelMap.set("name", info.model.name);
      map.set("model", modelMap);
    }
  });
}

export function addSession(ydoc: Y.Doc, session: SessionSummary): void {
  ydoc.transact(() => {
    const sessions = ydoc.getArray("sessions") as Y.Array<Y.Map<unknown>>;
    // 去重
    const exists = sessions.toArray().some((s) => s.get("sessionId") === session.sessionId);
    if (exists) return;

    const map = new Y.Map<unknown>();
    map.set("sessionId", session.sessionId);
    map.set("title", session.title);
    map.set("preview", session.preview);
    map.set("status", session.status);
    map.set("lastMsgTs", session.lastMsgTs);
    if (session.cwd) map.set("cwd", session.cwd);
    if (session.updatedAt) map.set("updatedAt", session.updatedAt);
    sessions.push([map]);
  });
}

/**
 * 全量同步 session 列表到 Chat Doc。
 * 在单个 Y.Doc 事务内完成增/改/删，确保 Yjs update 事件原子触发。
 * 无差异时跳过事务，避免空轮询触发不必要的 yjs:update 广播。
 */
export function syncSessions(ydoc: Y.Doc, sessions: SessionSummary[]): void {
  if (sessions.length === 0) return;

  const sessionsArray = ydoc.getArray("sessions") as Y.Array<Y.Map<unknown>>;

  // 构建已有 session 索引（差异检测和事务复用同一份）
  const existingIndex = new Map<string, Y.Map<unknown>>();
  for (let i = 0; i < sessionsArray.length; i++) {
    const s = sessionsArray.get(i);
    const id = s.get("sessionId") as string | undefined;
    if (id) existingIndex.set(id, s);
  }

  // 快速差异检测：数量相同、ID 集合相同、各字段均无变化 → 跳过事务
  if (sessionsArray.length === sessions.length) {
    let hasChanges = false;
    for (const session of sessions) {
      const existing = existingIndex.get(session.sessionId);
      if (!existing) {
        hasChanges = true;
        break;
      }
      if (
        existing.get("title") !== session.title ||
        existing.get("preview") !== session.preview ||
        existing.get("status") !== session.status ||
        existing.get("lastMsgTs") !== session.lastMsgTs ||
        existing.get("cwd") !== (session.cwd ?? null) ||
        existing.get("updatedAt") !== (session.updatedAt ?? null)
      ) {
        hasChanges = true;
        break;
      }
    }
    if (!hasChanges) return;
  }

  ydoc.transact(() => {
    const incoming = new Set<string>();

    for (const session of sessions) {
      incoming.add(session.sessionId);
      const existing = existingIndex.get(session.sessionId);
      if (existing) {
        // 复用差异检测的 Y.Map 引用原地更新
        existing.set("title", session.title);
        existing.set("preview", session.preview);
        existing.set("status", session.status);
        existing.set("lastMsgTs", session.lastMsgTs);
        // 使用显式 set(null) 替代 truthy check，支持清除字段
        existing.set("cwd", session.cwd ?? null);
        existing.set("updatedAt", session.updatedAt ?? null);
      } else {
        const map = new Y.Map<unknown>();
        map.set("sessionId", session.sessionId);
        map.set("title", session.title);
        map.set("preview", session.preview);
        map.set("status", session.status);
        map.set("lastMsgTs", session.lastMsgTs);
        if (session.cwd) map.set("cwd", session.cwd);
        if (session.updatedAt) map.set("updatedAt", session.updatedAt);
        sessionsArray.push([map]);
      }
    }

    // 删除不在传入列表中的冗余 session
    for (let i = sessionsArray.length - 1; i >= 0; i--) {
      const id = sessionsArray.get(i).get("sessionId") as string | undefined;
      if (id && !incoming.has(id)) {
        sessionsArray.delete(i, 1);
      }
    }
  });
}

export function updateSession(ydoc: Y.Doc, acpSessionId: string, patch: Partial<SessionSummary>): void {
  ydoc.transact(() => {
    const sessions = ydoc.getArray("sessions") as Y.Array<Y.Map<unknown>>;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions.get(i);
      if (s.get("sessionId") === acpSessionId) {
        if (patch.title !== undefined) s.set("title", patch.title);
        if (patch.preview !== undefined) s.set("preview", patch.preview);
        if (patch.status !== undefined) s.set("status", patch.status);
        if (patch.lastMsgTs !== undefined) s.set("lastMsgTs", patch.lastMsgTs);
        return;
      }
    }
  });
}

export function setActiveSession(ydoc: Y.Doc, acpSessionId: string): void {
  ydoc.transact(() => {
    ydoc.getMap("chatMeta").set("activeSessionId", acpSessionId);
    ydoc.getMap("chatMeta").set("isSwitchingSession", false);
  });
}

export function setSwitchingSession(ydoc: Y.Doc, switching: boolean): void {
  ydoc.transact(() => {
    ydoc.getMap("chatMeta").set("isSwitchingSession", switching);
  });
}

export function addPermission(ydoc: Y.Doc, perm: PermissionRequest): void {
  ydoc.transact(() => {
    const perms = ydoc.getArray("permissions") as Y.Array<Y.Map<unknown>>;
    const map = new Y.Map<unknown>();
    map.set("id", perm.id);
    map.set("tool", perm.tool);
    map.set("args", perm.args);
    map.set("level", perm.level);
    map.set("status", perm.status);
    map.set("ts", perm.ts);
    perms.push([map]);
  });
}

export function resolvePermission(ydoc: Y.Doc, permId: string, decision: "approved" | "denied"): void {
  ydoc.transact(() => {
    const perms = ydoc.getArray("permissions") as Y.Array<Y.Map<unknown>>;
    for (let i = 0; i < perms.length; i++) {
      const p = perms.get(i);
      if (p.get("id") === permId) {
        p.set("status", decision);
        return;
      }
    }
  });
}

// ── agent status / session 状态写入 ──

export function setCapabilities(ydoc: Y.Doc, caps: Record<string, unknown>): void {
  ydoc.transact(() => {
    const map = ydoc.getMap("capabilities");
    for (const [key, value] of Object.entries(caps)) {
      if (value != null && typeof value === "object" && !Array.isArray(value)) {
        const subMap = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          subMap.set(k, v);
        }
        map.set(key, subMap);
      } else {
        map.set(key, value);
      }
    }
  });
}

export function setModelState(
  ydoc: Y.Doc,
  state: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> },
): void {
  ydoc.transact(() => {
    const map = ydoc.getMap("modelState");
    map.set("currentModelId", state.currentModelId);
    const models = new Y.Array<Y.Map<unknown>>();
    for (const m of state.availableModels) {
      const mm = new Y.Map<unknown>();
      mm.set("modelId", m.modelId);
      mm.set("name", m.name);
      models.push([mm]);
    }
    map.set("availableModels", models);
  });
}

export function setModeState(
  ydoc: Y.Doc,
  state: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string | null }> },
): void {
  ydoc.transact(() => {
    const map = ydoc.getMap("modeState");
    map.set("currentModeId", state.currentModeId);
    const modes = new Y.Array<Y.Map<unknown>>();
    for (const m of state.availableModes) {
      const mm = new Y.Map<unknown>();
      mm.set("id", m.id);
      mm.set("name", m.name);
      if (m.description) mm.set("description", m.description);
      modes.push([mm]);
    }
    map.set("availableModes", modes);
  });
}

export function setAvailableCommands(ydoc: Y.Doc, commands: Array<{ name: string; description?: string }>): void {
  ydoc.transact(() => {
    const arr = ydoc.getArray("availableCommands") as Y.Array<Y.Map<unknown>>;
    arr.delete(0, arr.length);
    for (const cmd of commands) {
      const cm = new Y.Map<unknown>();
      cm.set("name", cmd.name);
      cm.set("description", cmd.description ?? "");
      arr.push([cm]);
    }
  });
}

export function setTokenUsage(
  ydoc: Y.Doc,
  usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number },
): void {
  ydoc.transact(() => {
    const map = ydoc.getMap("tokenUsage");
    if (usage.totalTokens != null) map.set("totalTokens", usage.totalTokens);
    if (usage.inputTokens != null) map.set("inputTokens", usage.inputTokens);
    if (usage.outputTokens != null) map.set("outputTokens", usage.outputTokens);
  });
}
