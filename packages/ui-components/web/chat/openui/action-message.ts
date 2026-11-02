/**
 * OpenUI 动作 → 用户消息 / 外链的纯逻辑（不依赖 React 与图标包，可被服务端渲染与单测直接引用）。
 */

import type { OpenUIActionEvent } from "@peri-code/sdk/openui";

/**
 * 把一次动作事件拼成要发给 Agent 的用户消息。
 *
 * 消息正文取 `humanFriendlyMessage`；表单值随附一个 ```json 围栏，让模型拿到结构化字段。
 * 两段都为空时返回空串，调用方据此跳过发送。
 */
export function composeOpenUIActionMessage(event: OpenUIActionEvent): string {
  const parts: string[] = [];
  const message = typeof event.humanFriendlyMessage === "string" ? event.humanFriendlyMessage.trim() : "";
  if (message) parts.push(message);

  const formState = event.formState;
  if (formState && typeof formState === "object" && Object.keys(formState).length > 0) {
    parts.push(["```json", JSON.stringify(formState, null, 2), "```"].join("\n"));
  }

  return parts.join("\n\n");
}

/**
 * 打开 OpenUI 的 `open_url` 动作：只放行 http/https，其余静默忽略。
 *
 * 链接来自模型输出，`javascript:` / `data:` 一类协议必须在这里拦掉；打开方式固定为新标签页，
 * 与 Markdown 链接的 `rel` 策略保持一致。
 */
export function openExternalUrl(value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") return;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (typeof window === "undefined") return;

  window.open(url.toString(), "_blank", "noopener,noreferrer");
}
