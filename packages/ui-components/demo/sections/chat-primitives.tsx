import {
  CodeBlock,
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  IframePreview,
  Message,
  MessageAttachment,
  MessageAttachments,
  MessageContent,
  MessageResponse,
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  Shimmer,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  ToolPermissionButtons,
} from "@fenix/ui-components";
// ToolPermissionButtons 的 props 用组件层同构类型（带索引签名，宿主额外字段可直接透传）；根 barrel 的
// `PermissionOption` 是 `chat/types` 的协议声明，两者结构兼容但声明独立，故这里按深链取组件层类型。
import type { PermissionOption } from "@fenix/ui-components/chat/primitives/permission-request";
import type { FileUIPart, TextUIPart, UIMessage } from "ai";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Chat 基础元件分区：Message / Conversation / PromptInput / Reasoning / Tool / CodeBlock /
 * Shimmer / PermissionRequest / MessageAttachments / IframePreview（对应包内 `web/chat/primitives`，
 * 即源 `web/ai-elements` 组改名后的形态）。
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
 *
 * 全部示例只使用本地静态数据（UIMessage / FileUIPart 结构），不访问任何后端；
 * PromptInput 与 ToolPermissionButtons 的交互回调只把载荷打到控制台，用于验证回调确实触发。
 */

const SAMPLE_CODE = `export function greet(name: string) {
  return \`hello \${name}\`;
}`;

/**
 * 三条静态消息，结构与 UIMessage 一致：演示时只读取其中的 text 片段。
 * `<demo-card>` 由 demo/providers.tsx 通过 registerTagRenderer 显式注册，
 * 注册表默认拒绝未注册标签（XSS 安全默认），因此该标签只在 demo 中会被渲染。
 */
const SAMPLE_MESSAGES: UIMessage[] = [
  {
    id: "demo-message-1",
    role: "user",
    parts: [{ type: "text", text: "What does this package export, and how do I render a reply?" }],
  },
  {
    id: "demo-message-2",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: [
          "### Two groups, one barrel",
          "",
          "Import from the package root, or deep-link a single module:",
          "",
          "```ts",
          'import { Button } from "@fenix/ui-components";',
          'import { Button as DeepButton } from "@fenix/ui-components/ui/button";',
          "```",
          "",
          "| Group | Example |",
          "| --- | --- |",
          "| `ui` | `Button`, `Dialog`, `Tabs` |",
          "| `chat/primitives` | `Message`, `PromptInput`, `Tool` |",
          "",
          "Custom tags need an explicit host registration:",
          "",
          '<demo-card title="card-renderer">registered tag</demo-card>',
        ].join("\n"),
      },
    ],
  },
  {
    id: "demo-message-3",
    role: "user",
    parts: [{ type: "text", text: "Can the assistant stream a partial answer?" }],
  },
  {
    id: "demo-message-4",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Yes — pass `isStreaming` to `Reasoning`, and `Shimmer` to mark a pending token. Both are shown below.",
      },
    ],
  },
];

/**
 * 内联 HTML 的 data URL：demo 不依赖任何外部站点，离线也能渲染出内容。
 * 该 iframe 由组件固定为 sandbox="allow-scripts allow-same-origin allow-popups"。
 */
const SAMPLE_IFRAME_SRC = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><body style="margin:0;display:grid;place-items:center;height:100vh;font-family:system-ui,sans-serif">' +
    '<p style="color:#475569">Sandboxed inline preview</p></body>',
)}`;

/** 图片附件用内联 SVG，离线可渲染；非图片附件只展示文件名，其 url 不会被读取。 */
const SAMPLE_ATTACHMENTS: FileUIPart[] = [
  {
    type: "file",
    mediaType: "image/svg+xml",
    filename: "preview.svg",
    url:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E" +
      "%3Crect width='96' height='96' fill='%236366f1'/%3E%3C/svg%3E",
  },
  { type: "file", mediaType: "application/pdf", filename: "spec.pdf", url: "about:blank" },
];

const SAMPLE_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

/** 只取文本片段：示例不覆盖 data / file / tool 等其它片段类型。 */
function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function ChatPrimitivesSection() {
  const { t } = useTranslation(DEMO_NS);
  const [submittedText, setSubmittedText] = useState<string | null>(null);
  const [permissionReply, setPermissionReply] = useState<string | null>(null);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.chatPrimitives")}</h1>

      <div className="demo-example">
        <h2 className="demo-example-title">Conversation / Message / MessageResponse</h2>
        {/* Conversation 内部滚动区高度为 100%，因此外层必须给出确定高度并作为 flex 容器。 */}
        <div className="flex h-[420px] flex-col overflow-hidden rounded-lg border border-border">
          <Conversation>
            <ConversationContent>
              {SAMPLE_MESSAGES.map((message) => (
                <Message key={message.id} from={message.role}>
                  <MessageContent>
                    {message.role === "assistant" ? (
                      <MessageResponse>{messageText(message)}</MessageResponse>
                    ) : (
                      messageText(message)
                    )}
                  </MessageContent>
                </Message>
              ))}
            </ConversationContent>
            {/* ConversationScrollButton 只提供外观与滚动行为，定位由宿主负责（源宿主用绝对定位容器）。 */}
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
              <ConversationScrollButton />
            </div>
          </Conversation>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">MessageAttachments</h2>
        <Message from="user">
          <MessageAttachments>
            {SAMPLE_ATTACHMENTS.map((attachment) => (
              <MessageAttachment
                key={attachment.filename}
                data={attachment}
                onRemove={() => {
                  console.log("message-attachment remove", attachment.filename);
                }}
              />
            ))}
          </MessageAttachments>
          <MessageContent>Two attachments: one image, one generic file.</MessageContent>
        </Message>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">PromptInput</h2>
        <PromptInput
          multiple
          onSubmit={(message) => {
            console.log("prompt-input submit", message);
            setSubmittedText(message.text);
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea placeholder="Ask the demo anything…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputSubmit />
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>
        <p className="demo-hint">
          {submittedText === null
            ? "Type a message and press Enter — the payload is logged to the console."
            : `Last submitted: ${submittedText}`}
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Reasoning</h2>
        <Reasoning defaultOpen>
          <ReasoningTrigger />
          <ReasoningContent>
            <div className="text-sm leading-relaxed">
              `isStreaming` 为 true 时自动展开，结束 1 秒后自动折叠；折叠状态也可以由宿主通过 `open` 接管。
            </div>
          </ReasoningContent>
        </Reasoning>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Tool / PermissionRequest</h2>
        <Tool defaultOpen>
          <ToolHeader type="tool-weather" state="output-available" title="weather" />
          <ToolContent>
            <ToolInput input={{ city: "Shanghai", unit: "celsius" }} />
            <ToolOutput output={{ temperature: 21, conditions: "cloudy" }} errorText={undefined} />
          </ToolContent>
        </Tool>

        <Tool defaultOpen>
          <ToolHeader type="tool-run-command" state="approval-requested" title="run-command" />
          <ToolContent>
            <ToolInput input={{ command: "bun install" }} />
            {/* ToolPermissionButtons（permission-request 模块）通常嵌在 Tool 内，由宿主把响应回传给 Agent。 */}
            <ToolPermissionButtons
              requestId="demo-request-1"
              options={SAMPLE_PERMISSION_OPTIONS}
              onRespond={(requestId, optionId, optionKind) => {
                console.log("permission respond", { requestId, optionId, optionKind });
                setPermissionReply(`${optionId} (${optionKind ?? "unknown"})`);
              }}
            />
          </ToolContent>
        </Tool>
        {permissionReply === null ? null : <p className="demo-hint">Responded with {permissionReply}</p>}
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">CodeBlock</h2>
        <CodeBlock code={SAMPLE_CODE} language="ts" />
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Shimmer</h2>
        <Shimmer>Waiting for the first token…</Shimmer>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">IframePreview</h2>
        <p className="demo-hint">Hover the frame and use the expand button to open the resizable preview dialog.</p>
        <IframePreview src={SAMPLE_IFRAME_SRC} title="Inline preview" width="100%" height="240" />
      </div>
    </section>
  );
}
