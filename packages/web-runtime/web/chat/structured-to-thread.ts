// packages/web-runtime/web/chat/structured-to-thread.ts
// 展示层转换：StructuredMessage[] → ThreadEntry[]（ChatInterface 渲染用的条目），
// 以及 Session Doc 三态权限选项 → acp-link PermissionOption 的展示映射。
//
// 职责错位纠正后消息时间线在 Chat Doc，那份投影（Chat Doc → StructuredMessage[]）与它的
// 增量派生缓存已按 §4.7 拆到 `./chat-doc-to-structured`；本文件只保留纯展示层映射，并在末尾
// 原样再导出 `chatDocEntriesToStructuredMessages`，`@fenix/web-runtime/chat/structured-to-thread`
// 的对外形状不变（既有消费者与测试无需改动）。

import type { PermissionOption, StructuredMessage } from "@fenix/chat-channel";
import { classifyToolSemantic, semanticToToolCardKind } from "@fenix/ui-components/chat/lib/tool-semantic";
import type {
  AssistantChunk,
  ThreadEntry,
  TodoItem,
  ToolCallData,
  ToolCallStatus,
} from "@fenix/ui-components/chat/types";
// 直接引用 i18next 全局实例（宿主 apps/web/src/i18n/index.ts 在此实例上注册各语言资源）：
// 不 import 宿主 i18n 单例模块 —— 测试环境有测试文件 mock.module 该模块为无 default
// 导出的假模块，静态 import 链会触发 "Missing default export"。
import i18n from "i18next";
import { getTodoChanges, getTodosFromRawInput } from "./todo";

/**
 * Session Doc 三态权限选项（allow_once/allow_session/deny）→ acp-link PermissionOption[]。
 * 仅用于展示翻译：optionId 保留 Session Doc 语义字符串（后端 CAS 以 deny/reject 前缀判拒，
 * 控制面 respond_permission 原样回传），kind 映射到最近邻 acp-link 枚举以驱动按钮样式。
 */
export function sessionOptionKindsToPermissionOptions(rawOptions: unknown): PermissionOption[] {
  const kinds = Array.isArray(rawOptions) ? rawOptions : [];
  const result: PermissionOption[] = [];
  for (const kind of kinds) {
    if (kind === "allow_once") {
      result.push({
        optionId: "allow_once",
        // i18next 未初始化（如测试环境）时 t 返回 undefined，回退 key 保证按钮文案非空
        name: i18n.t("permissionPanel.allow", { ns: "components" }) ?? "permissionPanel.allow",
        kind: "allow_once",
      });
    } else if (kind === "allow_session") {
      result.push({
        optionId: "allow_session",
        name: i18n.t("permissionPanel.allowSession", { ns: "components" }) ?? "permissionPanel.allowSession",
        kind: "allow_always",
      });
    } else if (kind === "deny") {
      result.push({
        optionId: "deny",
        name: i18n.t("permissionPanel.deny", { ns: "components" }) ?? "permissionPanel.deny",
        kind: "reject_once",
      });
    }
  }
  return result;
}

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
export function structuredToThreadEntries(messages: readonly StructuredMessage[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  let previousTodos: TodoItem[] | null = null;

  for (const m of messages) {
    switch (m.type) {
      case "assistant_message":
        entries.push({
          type: "assistant_message",
          id: m.id,
          chunks: m.chunks.map(
            (c): AssistantChunk => ({
              type: c.type,
              text: c.text,
            }),
          ),
          error: m.error,
        });
        break;

      case "user_message":
        entries.push({
          type: "user_message",
          id: m.id,
          content: m.content,
        });
        break;

      case "tool_call": {
        const permReq = m.permissionRequest
          ? ({
              requestId: m.permissionRequest.requestId,
              options: [...m.permissionRequest.options],
            } as unknown as ToolCallData["permissionRequest"])
          : undefined;
        const display = m.display
          ? {
              type: m.display.type,
              path: m.display.path,
              lineStart: m.display.lineStart,
              lineEnd: m.display.lineEnd,
              totalLines: m.display.totalLines,
              text: m.display.text,
              truncated: m.display.truncated,
            }
          : undefined;
        const semantic = classifyToolSemantic({ name: m.title, rawInput: m.rawInput, display });
        const projectedSemantic = semantic === "todo" && !m.rawInput ? "other" : semantic;
        const todos = projectedSemantic === "todo" ? getTodosFromRawInput(m.rawInput) : null;
        const todoChanges = todos ? getTodoChanges(previousTodos ?? [], todos) : undefined;
        if (todos) previousTodos = todos;

        const toolCallData: ToolCallData = {
          id: m.id,
          title: m.title,
          status: mapStatus(m.status),
          content: m.content as ToolCallData["content"],
          rawInput: m.rawInput,
          rawOutput: m.rawOutput,
          display,
          semantic: projectedSemantic,
          kind: semanticToToolCardKind(projectedSemantic),
          todoChanges,
          permissionRequest: permReq,
          isStandalonePermission: m.isStandalonePermission,
          publicError: m.publicError,
          subEntries: m.subMessages ? structuredToThreadEntries(m.subMessages) : undefined,
        };
        entries.push({ type: "tool_call", toolCall: toolCallData });
        break;
      }

      case "plan":
        entries.push({ type: "plan", id: m.id, turnId: m.turnId, entries: m.entries });
        break;

      default:
        entries.push({
          type: "assistant_message",
          id: `unknown-${Date.now()}`,
          chunks: [],
        });
    }
  }

  return entries;
}

// =============================================================================
// 新 schema 派生：Chat Doc（entries/blocks）→ StructuredMessage[]
// =============================================================================

// 实现已按 §4.7 拆到 `./chat-doc-to-structured`（只碰 Y.Doc 的那一半：entry/toolCall 结构、
// per-entry 派生缓存与失效观察者）。这里再导出，保持本入口文件的对外形状不变。
export { chatDocEntriesToStructuredMessages } from "./chat-doc-to-structured";
