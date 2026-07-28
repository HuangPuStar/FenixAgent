// web/src/lib/structured-to-thread.ts
// Yjs StructuredMessage[] → ThreadEntry[] 渲染转换层

import type { StructuredMessage } from "@fenix/acp-server";
import type { AssistantChunk, PlanDisplayEntry, ThreadEntry, ToolCallData, ToolCallStatus } from "./types";

function mapStatus(status: string): ToolCallStatus {
  switch (status) {
    case "running":
      return "running";
    case "complete":
    case "completed":
      return "complete";
    case "error":
      return "error";
    case "waiting_for_confirmation":
      return "waiting_for_confirmation";
    case "canceled":
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
