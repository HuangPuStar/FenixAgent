// packages/acp-server/src/aggregator.ts
import * as Y from "yjs";
import type { ACPEvent } from "../types";

/**
 * 处理一个 ACP 事件，在其对应的 Session Doc 上执行状态变更。
 * 纯函数——不做 I/O，只在 ydoc.transact 中操作 Yjs 结构。
 */
export function applyACPEvent(ydoc: Y.Doc, event: ACPEvent): void {
  ydoc.transact(() => {
    const meta = ydoc.getMap("meta");
    const messages = ydoc.getArray("messages") as Y.Array<Y.Map<unknown>>;
    const streaming = ydoc.getMap("streaming");
    const tools = ydoc.getMap("tools") as Y.Map<Y.Map<unknown>>;
    const artifacts = ydoc.getArray("artifacts") as Y.Array<Y.Map<unknown>>;
    // Phase C: 结构化消息时间线（与旧 messages/tools 并存）
    const structuredMessages = ydoc.getArray("structuredMessages") as Y.Array<Y.Map<unknown>>;

    switch (event.type) {
      // ── 消息 chunk → 流式聚合 ──
      case "agent_message_chunk": {
        const text =
          ((event.payload?.content as Record<string, unknown>)?.text as string) ||
          ((event.payload as Record<string, unknown>)?.text as string) ||
          "";
        const existing = (streaming.get("text") as string) || "";
        streaming.set("text", existing + text);
        meta.set("status", "responding");
        // 不在此处清除 loading：loading 从 user_message_chunk 设置后应保持到
        // prompt_complete / agent_message_complete / error 才清除，否则 Cancel 按钮
        // 会在流式输出期间消失。
        meta.set("updatedAt", Date.now());

        // Phase C: 结构化消息 — assistant_message chunk 累积
        {
          const lastIdx = structuredMessages.length - 1;
          const last = lastIdx >= 0 ? structuredMessages.get(lastIdx) : null;

          if (last?.get("type") === "assistant_message") {
            const chunks = last.get("chunks") as Y.Array<Y.Map<unknown>>;
            const lastChunkIdx = chunks.length - 1;
            const lastChunk = lastChunkIdx >= 0 ? chunks.get(lastChunkIdx) : null;
            if (lastChunk?.get("type") === "message") {
              lastChunk.set("text", (lastChunk.get("text") as string) + text);
            } else {
              const chunk = new Y.Map<unknown>();
              chunk.set("type", "message");
              chunk.set("text", text);
              chunks.push([chunk]);
            }
          } else {
            const msg = new Y.Map<unknown>();
            msg.set("type", "assistant_message");
            msg.set("id", `assistant-${Date.now()}`);
            msg.set("seq", structuredMessages.length);
            msg.set("ts", Date.now());
            const chunks = new Y.Array<Y.Map<unknown>>();
            const chunk = new Y.Map<unknown>();
            chunk.set("type", "message");
            chunk.set("text", text);
            chunks.push([chunk]);
            msg.set("chunks", chunks);
            structuredMessages.push([msg]);
          }
        }
        break;
      }

      // ── 思考 chunk ──
      case "agent_thought_chunk": {
        const text =
          ((event.payload?.content as Record<string, unknown>)?.text as string) ||
          // 兼容 fallback 路径：非 session/update 事件 payload 就是 content block 自身
          ((event.payload as Record<string, unknown>)?.text as string) ||
          "";
        const existing = (streaming.get("reasoning") as string) || "";
        streaming.set("reasoning", existing + text);
        meta.set("status", "thinking");
        meta.set("updatedAt", Date.now());

        // Phase C: 结构化消息 — thought chunk 累积到当前 assistant_message
        // 如果尚不存在 assistant_message（如 thinking 先于 message text 到达），创建之
        {
          const lastIdx = structuredMessages.length - 1;
          const last = lastIdx >= 0 ? structuredMessages.get(lastIdx) : null;

          if (last?.get("type") === "assistant_message") {
            const chunks = last.get("chunks") as Y.Array<Y.Map<unknown>>;
            const lastChunkIdx = chunks.length - 1;
            const lastChunk = lastChunkIdx >= 0 ? chunks.get(lastChunkIdx) : null;
            if (lastChunk?.get("type") === "thought") {
              lastChunk.set("text", (lastChunk.get("text") as string) + text);
            } else {
              const chunk = new Y.Map<unknown>();
              chunk.set("type", "thought");
              chunk.set("text", text);
              chunks.push([chunk]);
            }
          } else {
            const msg = new Y.Map<unknown>();
            msg.set("type", "assistant_message");
            msg.set("id", `assistant-${Date.now()}`);
            msg.set("seq", structuredMessages.length);
            msg.set("ts", Date.now());
            const chunks = new Y.Array<Y.Map<unknown>>();
            const chunk = new Y.Map<unknown>();
            chunk.set("type", "thought");
            chunk.set("text", text);
            chunks.push([chunk]);
            msg.set("chunks", chunks);
            structuredMessages.push([msg]);
          }
        }
        break;
      }

      // ── 消息完成 → flush 到 messages ──
      case "prompt_complete":
      case "agent_message_complete": {
        const content = streaming.get("text") as string;
        if (content) {
          const msg = new Y.Map<unknown>();
          msg.set("role", "assistant");
          msg.set("content", content);
          msg.set("seq", messages.length);
          msg.set("ts", Date.now());
          messages.push([msg]);
          streaming.delete("text");
        }
        meta.set("status", "done");
        meta.set("loading", null);
        meta.set("updatedAt", Date.now());
        break;
      }

      // ── 工具调用开始 ──
      case "tool_call": {
        // Dual-format: conformant agents use toolCallId/title/rawInput at update root;
        // claude-acp-adapter embeds tool_use data {id, name, input} inside content.
        const payload = event.payload as Record<string, unknown> | undefined;
        const inner = payload?.content as Record<string, unknown> | undefined;
        const innerId = inner?.id as string | undefined;

        const id = (payload?.toolCallId as string) || innerId || `tool_${Date.now()}`;
        const name = (payload?.title as string) || (inner?.name as string) || "";
        const input = (payload?.rawInput as Record<string, unknown>) || (inner?.input as Record<string, unknown>) || {};
        // 非流式 agent 可能在 tool_call 中直接发送完整结果（status + rawOutput）
        // ACP 协议发送 "completed"，前端 YJS 数据层使用 "complete"（无 d），此处归一化
        const rawStatus = (payload?.status as string) || "running";
        const status = rawStatus === "completed" ? "complete" : rawStatus;
        const rawOutput = payload?.rawOutput ?? inner?.rawOutput;

        const tool = new Y.Map<unknown>();
        tool.set("name", name);
        tool.set("status", status);
        tool.set("input", input);
        tool.set("startedAt", Date.now());
        if (rawOutput != null) {
          tool.set("output", rawOutput);
        }
        tools.set(id, tool);
        meta.set("status", "tool-calling");
        meta.set("updatedAt", Date.now());

        // Phase C: 结构化消息 — tool_call 条目
        {
          const msg = new Y.Map<unknown>();
          msg.set("type", "tool_call");
          msg.set("id", id);
          msg.set("title", name);
          msg.set("status", status);
          msg.set("kind", (payload?.kind as string) ?? undefined);
          msg.set("seq", structuredMessages.length);
          msg.set("ts", Date.now());
          const contentArray = new Y.Array<Y.Map<unknown>>();
          msg.set("content", contentArray);
          msg.set("rawInput", input);
          if (rawOutput != null) {
            msg.set("rawOutput", rawOutput);
          }
          structuredMessages.push([msg]);
        }

        // 如果 tool_call 已携带输出，同步更新 artifacts
        if (rawOutput != null && status === "completed") {
          extractArtifacts(artifacts, rawOutput, messages.length);
        }
        break;
      }

      // ── 工具调用结果 ──
      case "tool_call_result": {
        // Dual-format：JSON-RPC 路径数据嵌套在 payload.content 内，直接路径数据在 payload 顶层
        const payload = event.payload as Record<string, unknown> | undefined;
        const inner = payload?.content as Record<string, unknown> | undefined;
        const id = (payload?.id as string) || (inner?.id as string);
        const output = payload?.output ?? inner?.output;
        const isError = (payload?.isError ?? inner?.isError) as boolean | undefined;
        if (id) {
          const tool = tools.get(id);
          if (tool) {
            tool.set("status", isError ? "error" : "done");
            tool.set("output", output || "");
            // 提取链接/文件引用
            extractArtifacts(artifacts, output, messages.length);
          }
        }
        meta.set("updatedAt", Date.now());

        // Phase C: 更新 structuredMessages 中对应 tool_call 状态
        if (id) {
          for (let i = structuredMessages.length - 1; i >= 0; i--) {
            const m = structuredMessages.get(i);
            if (m.get("type") === "tool_call" && m.get("id") === id) {
              m.set("status", isError ? "error" : "complete");
              if (output != null) {
                m.set("rawOutput", output);
              }
              break;
            }
          }
        }
        break;
      }

      // ── 工具调用错误 ──
      case "tool_call_error": {
        const id = event.payload?.id as string;
        if (id) {
          const tool = tools.get(id);
          if (tool) {
            tool.set("status", "error");
            tool.set("output", event.payload?.error || "Unknown error");
          }
        }
        meta.set("updatedAt", Date.now());

        // Phase C: 更新 structuredMessages 中对应 tool_call 状态
        if (id) {
          for (let i = structuredMessages.length - 1; i >= 0; i--) {
            const m = structuredMessages.get(i);
            if (m.get("type") === "tool_call" && m.get("id") === id) {
              m.set("status", "error");
              if (event.payload?.error != null) {
                m.set("rawOutput", { error: event.payload.error });
              }
              break;
            }
          }
        }
        break;
      }

      // ── 工具调用状态更新 ──
      case "tool_call_update": {
        const payload = event.payload as Record<string, unknown> | undefined;
        const inner = payload?.content as Record<string, unknown> | undefined;
        // ID: 兼容 payload.toolCallId (顶层) 和 inner.toolCallId / inner.id (嵌套)
        const id = (payload?.toolCallId as string) || (inner?.toolCallId as string) || (inner?.id as string);
        if (!id) break;

        // 字段值优先从顶层取，回退到嵌套 content 内
        const status = (payload?.status ?? inner?.status) as string | undefined;
        const title = (payload?.title ?? inner?.title) as string | undefined;
        const rawOutput = payload?.rawOutput ?? inner?.rawOutput;
        const rawInput = payload?.rawInput ?? inner?.rawInput;

        // ACP 协议发送 "completed"/"done"，YJS 存储使用 "complete"（无 d），归一化
        const canonicalStatus = status === "completed" || status === "done" ? "complete" : status;

        // Update tools map entry
        const tool = tools.get(id);
        if (tool) {
          if (canonicalStatus != null) {
            tool.set("status", canonicalStatus);
          }
          if (title != null) {
            tool.set("name", title);
          }
          if (rawOutput != null) {
            tool.set("output", rawOutput);
          }
        }

        // Update structuredMessages tool_call entry (search from end)
        for (let i = structuredMessages.length - 1; i >= 0; i--) {
          const m = structuredMessages.get(i);
          if (m.get("type") === "tool_call" && m.get("id") === id) {
            if (canonicalStatus != null) {
              m.set("status", canonicalStatus);
            }
            if (title != null) {
              m.set("title", title);
            }
            if (rawOutput != null) {
              m.set("rawOutput", rawOutput);
            }
            if (rawInput != null) {
              m.set("rawInput", rawInput);
            }
            // Append content blocks if provided (direct path only: payload.content is Array;
            // JSON-RPC wrapper path uses inner = payload.content for metadata, blocks would be at inner.content)
            const outerContent =
              (Array.isArray(payload?.content) ? payload?.content : null) ??
              (inner?.content && Array.isArray(inner.content) ? inner.content : null);
            if (outerContent) {
              const existingContent = m.get("content") as Y.Array<Y.Map<unknown>>;
              for (const block of outerContent as Array<Record<string, unknown>>) {
                const cm = new Y.Map<unknown>();
                cm.set("type", (block.type as string) || "content");
                if (block.content != null) cm.set("content", block.content);
                if (block.path != null) cm.set("path", block.path);
                if (block.oldText != null) cm.set("oldText", block.oldText);
                if (block.newText != null) cm.set("newText", block.newText);
                if (block.terminalId != null) cm.set("terminalId", block.terminalId);
                existingContent.push([cm]);
              }
            }
            break;
          }
        }

        meta.set("updatedAt", Date.now());
        break;
      }

      // ── Agent 执行计划 ──
      case "plan": {
        const payload = event.payload as Record<string, unknown> | undefined;
        const entries = payload?.entries as Array<Record<string, unknown>> | undefined;
        if (!entries || entries.length === 0) {
          // Empty entries list means clear plan
          for (let i = structuredMessages.length - 1; i >= 0; i--) {
            if (structuredMessages.get(i).get("type") === "plan") {
              structuredMessages.delete(i, 1);
              break;
            }
          }
        } else {
          // Build plan entries Y.Array
          const planEntries = new Y.Array<Y.Map<unknown>>();
          for (const e of entries) {
            const pe = new Y.Map<unknown>();
            pe.set("content", (e.content as string) || "");
            pe.set("priority", (e.priority as string) || "medium");
            pe.set("status", (e.status as string) || "pending");
            planEntries.push([pe]);
          }

          // Find existing plan entry or create new
          let planIdx = -1;
          for (let i = structuredMessages.length - 1; i >= 0; i--) {
            if (structuredMessages.get(i).get("type") === "plan") {
              planIdx = i;
              break;
            }
          }

          if (planIdx >= 0) {
            const existing = structuredMessages.get(planIdx);
            existing.set("entries", planEntries);
          } else {
            const pm = new Y.Map<unknown>();
            pm.set("type", "plan");
            pm.set("id", `plan-${Date.now()}`);
            pm.set("seq", structuredMessages.length);
            pm.set("ts", Date.now());
            pm.set("entries", planEntries);
            structuredMessages.push([pm]);
          }
        }

        meta.set("status", "plan");
        meta.set("updatedAt", Date.now());
        break;
      }

      // ── 会话状态更新 ──
      case "session_update": {
        const update = event.payload?.sessionUpdate as string;
        if (update) {
          meta.set("status", update);
          // 终端/空闲/就绪状态清除 loading，确保切换回已完成会话（或 load_session
          // 历史回放完成后）时不会残留加载态。ready 由 relay 在 session/load 响应
          // 到达时广播，用于复位回放 user_message_chunk 触发的 loading。
          if (update === "done" || update === "idle" || update === "error" || update === "ready") {
            meta.set("loading", null);
          }
        }
        meta.set("updatedAt", Date.now());
        break;
      }

      // ── Session 错误 ──
      case "session_error":
      case "error": {
        meta.set("status", "error");
        meta.set("loading", null);
        meta.set("updatedAt", Date.now());
        break;
      }

      // ── 用户消息（服务端记录）──
      case "user_message_chunk": {
        const text = ((event.payload?.content as Record<string, unknown>)?.text as string) || "";

        // 去重：backend 在 yjs-frontend 中已直接调用 processACP 写入了用户消息，
        // agent (acp-link) 又会回显 user_message_chunk→重复。检查末尾若已有相同内容的
        // user_message（structuredMessages 最后一条，或 messages 最后一条），且在 2 秒内则跳过。
        {
          const lastSmIdx = structuredMessages.length - 1;
          if (lastSmIdx >= 0) {
            const lastSm = structuredMessages.get(lastSmIdx);
            if (lastSm?.get("type") === "user_message" && lastSm.get("content") === text) {
              const ts = lastSm.get("ts") as number;
              if (ts && Date.now() - ts < 2000) {
                break;
              }
            }
          }
          const lastMsgIdx = messages.length - 1;
          if (lastMsgIdx >= 0) {
            const lastMsg = messages.get(lastMsgIdx);
            if (lastMsg?.get("role") === "user" && lastMsg.get("content") === text) {
              const ts = lastMsg.get("ts") as number;
              if (ts && Date.now() - ts < 2000) {
                break;
              }
            }
          }
        }

        const msg = new Y.Map<unknown>();
        msg.set("role", "user");
        msg.set("content", text);
        msg.set("seq", messages.length);
        msg.set("ts", Date.now());
        messages.push([msg]);

        meta.set("status", "loading");
        meta.set("loading", {
          kind: "session/respond",
          label: "Agent is thinking...",
          since: Date.now(),
        });
        meta.set("updatedAt", Date.now());

        // Phase C: 结构化消息 — user_message 条目
        {
          const sm = new Y.Map<unknown>();
          sm.set("type", "user_message");
          sm.set("id", `user-${Date.now()}`);
          sm.set("content", text);
          sm.set("seq", structuredMessages.length);
          sm.set("ts", Date.now());
          structuredMessages.push([sm]);
        }
        break;
      }

      // 未识别的类型——不处理
      default:
        break;
    }
  });
}

/** 从工具输出中提取链接/文件引用 */
function extractArtifacts(artifacts: Y.Array<Y.Map<unknown>>, output: unknown, seq: number): void {
  if (typeof output !== "string") return;

  // URL 模式
  const urlPattern = /https?:\/\/[^\s"'<>]+/g;
  for (const match of output.matchAll(urlPattern)) {
    const url = match[0];
    if (artifacts.toArray().some((a) => a.get("url") === url)) continue;

    const artifact = new Y.Map<unknown>();
    artifact.set("kind", url.match(/\.(png|jpg|jpeg|gif|svg|webp)/i) ? "image" : "url");
    artifact.set("url", url);
    artifact.set("title", url.split("/").pop() || url);
    artifact.set("seq", seq);
    artifacts.push([artifact]);
  }

  // 文件路径模式
  const filePattern = /(?:^|\s)((?:\/[\w.-]+)+\.\w+)/g;
  for (const match of output.matchAll(filePattern)) {
    const path = match[1];
    if (artifacts.toArray().some((a) => a.get("url") === path)) continue;

    const artifact = new Y.Map<unknown>();
    artifact.set("kind", "file");
    artifact.set("url", path);
    artifact.set("title", path.split("/").pop() || path);
    artifact.set("seq", seq);
    artifacts.push([artifact]);
  }
}
