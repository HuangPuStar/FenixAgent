// web/src/lib/structured-to-thread.ts
// 新 schema（文档 5.2 Chat Doc：entries/blocks）→ StructuredMessage[] → ThreadEntry[] 渲染转换层。
//
// 职责错位纠正后消息时间线在 Chat Doc，本文件新增 chatDocEntriesToStructuredMessages：
// Chat Doc → 展示层 StructuredMessage[]（保持既有 StructuredMessage 形状，
// 使 structuredToThreadEntries 与上层组件无需感知 schema 变化）。

import type { StructuredMessage } from "@fenix/chat-channel";
import * as Y from "yjs";
import type { AssistantChunk, PlanDisplayEntry, ThreadEntry, ToolCallData, ToolCallStatus } from "./types";

function mapStatus(status: string): ToolCallStatus {
  switch (status) {
    case "running":
      return "running";
    case "complete":
    case "completed":
    case "done":
      return "complete";
    case "error":
      return "error";
    case "waiting_for_confirmation":
    case "awaiting_permission":
      return "waiting_for_confirmation";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "rejected":
      return "rejected";
    default:
      return "running";
  }
}

/**
 * 将 Yjs StructuredMessage[] 转换为 ChatInterface 渲染用的 ThreadEntry[]。
 * 纯函数，无副作用。
 */
export function structuredToThreadEntries(messages: StructuredMessage[]): ThreadEntry[] {
  return messages.map((m): ThreadEntry => {
    switch (m.type) {
      case "assistant_message":
        return {
          type: "assistant_message",
          id: m.id,
          chunks: m.chunks.map(
            (c): AssistantChunk => ({
              type: c.type,
              text: c.text,
            }),
          ),
        };

      case "user_message":
        return {
          type: "user_message",
          id: m.id,
          content: m.content,
        };

      case "tool_call": {
        const permReq = m.permissionRequest
          ? ({
              requestId: m.permissionRequest.requestId,
              options: [...m.permissionRequest.options],
            } as unknown as ToolCallData["permissionRequest"])
          : undefined;

        const toolCallData: ToolCallData = {
          id: m.id,
          title: m.title,
          status: mapStatus(m.status),
          content: m.content as ToolCallData["content"],
          rawInput: m.rawInput,
          rawOutput: m.rawOutput,
          display: m.display
            ? {
                type: m.display.type,
                path: m.display.path,
                lineStart: m.display.lineStart,
                lineEnd: m.display.lineEnd,
                totalLines: m.display.totalLines,
                text: m.display.text,
                truncated: m.display.truncated,
              }
            : undefined,
          permissionRequest: permReq,
          isStandalonePermission: m.isStandalonePermission,
          subEntries: m.subMessages ? structuredToThreadEntries(m.subMessages) : undefined,
        };
        return { type: "tool_call", toolCall: toolCallData };
      }

      case "plan":
        return {
          type: "plan",
          id: m.id,
          entries: m.entries.map((e) => ({
            content: e.content,
            priority: e.priority,
            status: e.status,
          })),
        } as PlanDisplayEntry;

      default:
        return {
          type: "assistant_message",
          id: `unknown-${Date.now()}`,
          chunks: [],
        };
    }
  });
}

// =============================================================================
// 新 schema 派生：Chat Doc（entries/blocks）→ StructuredMessage[]
// =============================================================================

/** 读取 Chat Doc 根对象（与后端 factory 物理结构一致） */
function getChatRoot(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap("root");
}

/** 提取 block 文本（Y.Text） */
function blockText(block: Y.Map<unknown> | undefined): string {
  if (!block) return "";
  const text = block.get("text");
  return text instanceof Y.Text ? text.toString() : "";
}

/** 从 Chat Doc 按 entryOrder 顺序派生 StructuredMessage[]（保持既有展示形状） */
export function chatDocEntriesToStructuredMessages(ydoc: Y.Doc): StructuredMessage[] {
  const root = getChatRoot(ydoc);
  const order = (root.get("entryOrder") as Y.Array<string> | undefined) ?? new Y.Array<string>();
  const entries = (root.get("entries") as Y.Map<Y.Map<unknown>> | undefined) ?? new Y.Map<Y.Map<unknown>>();
  const toolCalls = (root.get("toolCalls") as Y.Map<Y.Map<unknown>> | undefined) ?? new Y.Map<Y.Map<unknown>>();

  const messages: StructuredMessage[] = [];
  const entryIds = order.toArray();
  for (let seq = 0; seq < entryIds.length; seq++) {
    const entryId = entryIds[seq] ?? "";
    const entry = entries.get(entryId);
    if (!entry) continue;

    const kind = entry.get("kind") as string | undefined;
    const role = entry.get("role") as string | undefined;
    const blockOrder = (entry.get("blockOrder") as Y.Array<string> | undefined)?.toArray() ?? [];
    const blocks = (entry.get("blocks") as Y.Map<Y.Map<unknown>> | undefined) ?? new Y.Map<Y.Map<unknown>>();
    const ts = entry.get("createdAt") ? new Date(entry.get("createdAt") as string).getTime() : Date.now();

    if (kind === "message" && role === "user") {
      const content = blockOrder
        .map((blockId) => blockText(blocks.get(blockId)))
        .filter(Boolean)
        .join("\n");
      messages.push({ type: "user_message", id: entryId, content, seq, ts });
      continue;
    }

    if (kind === "message" && role === "assistant") {
      const chunks: AssistantChunk[] = [];
      // 遍历 blockOrder 保持输出顺序：reasoning → thought 块，text → message 块
      for (const blockId of blockOrder) {
        const block = blocks.get(blockId);
        if (!block) continue;
        const blockType = block.get("type") as string | undefined;
        const text = blockText(block);
        if (blockType === "reasoning" && text) chunks.push({ type: "thought", text });
        else if (blockType === "text" && text) chunks.push({ type: "message", text });
      }
      messages.push({ type: "assistant_message", id: entryId, chunks, seq, ts });
    }

    // 工具调用：assistant entry 内的 tool_call block 按出现顺序投影为独立条目
    for (const blockId of blockOrder) {
      const block = blocks.get(blockId);
      if (!block) continue;
      if (block.get("type") !== "tool_call") continue;
      const toolCallId = block.get("toolCallId") as string | undefined;
      if (!toolCallId) continue;
      const tool = toolCalls.get(toolCallId);
      if (!tool) continue;

      const status = (tool.get("status") as string) || "running";
      const permissionId = tool.get("permissionId") as string | null | undefined;
      const message: StructuredMessage = {
        type: "tool_call",
        id: toolCallId,
        title: (tool.get("name") as string) || "",
        status: mapToolCallMessageStatus(status),
        content: [],
        rawInput: (tool.get("arguments") as Record<string, unknown> | undefined) ?? undefined,
        rawOutput: (tool.get("result") as Record<string, unknown> | undefined) ?? undefined,
      };
      if (permissionId) {
        message.permissionRequest = { requestId: permissionId, options: [] };
      }
      messages.push(message);
    }

    // plan 以 system entry 投影（planEntries 结构化字段 + 人类可读摘要）
    if (kind === "system") {
      const planEntries = entry.get("planEntries") as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(planEntries)) {
        messages.push({
          type: "plan",
          id: entryId,
          entries: planEntries.map((e) => ({
            content: (e.content as string) || "",
            priority: (e.priority as "high" | "medium" | "low") || "medium",
            status: (e.status as "pending" | "in_progress" | "completed") || "pending",
          })),
        });
      }
    }
  }
  return messages;
}

/** ToolCallProjection 状态 → ToolCallMessage 展示状态 */
function mapToolCallMessageStatus(status: string): ToolCallMessageStatus {
  switch (status) {
    case "completed":
      return "complete";
    case "awaiting_permission":
      return "waiting_for_confirmation";
    case "cancelled":
      return "canceled";
    case "error":
      return "error";
    default:
      return "running";
  }
}

type ToolCallMessageStatus = "running" | "complete" | "error" | "waiting_for_confirmation" | "canceled" | "rejected";
