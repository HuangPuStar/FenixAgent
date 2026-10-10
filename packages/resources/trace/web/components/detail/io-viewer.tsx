/**
 * IoViewer —— observation 输入 / 输出的智能查看器。
 *
 * 移植来源：langfuse-lite `components/io-viewer.tsx`。
 *
 * 自动识别 chat 形状的载荷（`{messages: [...]}` 或裸消息数组），给出 Chat ⇄ JSON 切换；非 chat 数据直接
 * 走 JSON 视图。判定与解析全部复用 `../../lib/chat-utils`，这里只做「识别 → 选视图」这一件事；JSON 视图的
 * `JsonViewer` 来自 `@fenix/ui-components/ui/json-view`（2026-10-10 起为平台共享件）。
 *
 * 本次适配：去掉参考实现的复制 / 下载动作（详情面板只做纯渲染），文案走 `t()`，配色换成本项目 token。
 */
import { cn } from "@fenix/ui-components/lib/cn";
import { JsonViewer } from "@fenix/ui-components/ui/json-view";
import { Braces, MessageSquareText } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TRACE_NS } from "../../i18n/namespace";
import { extractMessages, isChatPayload, parseMaybeString } from "../../lib/chat-utils";
import { ChatViewer } from "./chat-view";

type ViewMode = "chat" | "json";

function ModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  const { t } = useTranslation(TRACE_NS);
  const base = "inline-flex h-full items-center gap-1 rounded-7 px-2.5 text-11 font-medium transition-all";
  return (
    <div className="inline-flex h-7 items-center rounded-md border border-border-subtle bg-surface-2/60 p-0.5">
      <button
        type="button"
        aria-pressed={mode === "chat"}
        onClick={() => onChange("chat")}
        className={cn(
          base,
          mode === "chat" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary",
        )}
      >
        <MessageSquareText className="h-3 w-3" />
        {t("detail.chat")}
      </button>
      <button
        type="button"
        aria-pressed={mode === "json"}
        onClick={() => onChange("json")}
        className={cn(
          base,
          mode === "json" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary",
        )}
      >
        <Braces className="h-3 w-3" />
        {t("detail.json")}
      </button>
    </div>
  );
}

export function IoViewer({ data }: { data: unknown }) {
  // 上游把 IO 以 JSON 字符串下发，所以形状判定前必须先试着解析一次。
  const parsed = useMemo(() => parseMaybeString(data), [data]);
  const isChat = useMemo(() => isChatPayload(parsed), [parsed]);
  const messages = useMemo(() => (isChat ? extractMessages(parsed) : null), [isChat, parsed]);
  const [mode, setMode] = useState<ViewMode>("chat");

  if (!isChat || !messages) {
    return <JsonViewer data={parsed} />;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      {/* 切到 JSON 时渲染原始 data 而不是解析结果：用户要对比的就是「服务端到底下发了什么」。 */}
      {mode === "chat" ? <ChatViewer messages={messages} /> : <JsonViewer data={data} />}
    </div>
  );
}
