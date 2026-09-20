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
  Shimmer,
} from "@fenix/ui-components";
import type { FileUIPart, TextUIPart, UIMessage } from "ai";

/**
 * Base UI P3 · 从 Chat 下沉的通用展示件。
 *
 * 判据是「不涉及会话 / 工具 / 推理这些领域概念，任何页面都能直接用」：下面五组原先挂在 Chat L4
 * （消息基元）下，但组件本身不带 chat 语义 —— 放在 chat 分区里，只想展示一段代码、一个加载占位
 * 或一组对话气泡的宿主，会误以为要连整套会话体系一起引入；因此改由 P3 收编，示例也从 chat 的
 * 状态机上下文里摘出来，保证脱离会话也能独立成立。
 *
 * 保留在 Chat L4 的是必须认识会话交互形状的基元：PromptInput（提示词输入）、Reasoning（推理块）、
 * Tool / ToolPermissionButtons（工具调用与审批）。
 *
 * 各组的契约就是本文件演示的全部，示例不额外加戏：
 * - Conversation / Message / MessageResponse 只负责「一段对话长什么样」：滚动区高度为 100%，由外层
 *   给出确定高度；回复正文交给 streamdown 渲染（自定义标签需要宿主显式注册，见 providers.tsx）。
 * - MessageAttachments 只排布宿主喂进来的 FileUIPart，图片按 url 展示，其余只显示文件名。
 * - CodeBlock 只负责代码展示与排版，不取数、不执行、不做语法高亮；`language` 目前只作为 prop 保留
 *   （源码中承载语言标签与复制按钮的 header 被注释掉，复制能力仍可由宿主自行装配 `CodeBlockCopyButton`）。
 * - Shimmer 只是加载占位文字，动效仅作用于自身透明度，不代表任何进度或结果。
 * - IframePreview 只吃 src / title / 尺寸，沙箱策略由组件固定，宿主无法通过 props 放宽或收紧。
 *
 * 示例数据全部是文件内的静态常量，不触网：iframe 用内联 HTML 的 data: URL，附件用内联 SVG，
 * 离线也能渲染出内容。
 */

const SAMPLE_CODE = `export function greet(name: string) {
  return \`hello \${name}\`;
}`;

/**
 * 三条静态消息，结构与 UIMessage 一致：示例时只读取其中的 text 片段。
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
        text: "Yes — pass `isStreaming` to `Reasoning`, or `Shimmer` to mark a pending token.",
      },
    ],
  },
];

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

/**
 * 内联 HTML 的 data URL：demo 不依赖任何外部站点，离线也能渲染出内容。
 * 该 iframe 由组件固定为 sandbox="allow-scripts allow-same-origin allow-popups"。
 */
const SAMPLE_IFRAME_SRC = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><body style="margin:0;display:grid;place-items:center;height:100vh;font-family:system-ui,sans-serif">' +
    '<p style="color:#475569">Sandboxed inline preview</p></body>',
)}`;

/** 只取文本片段：示例不覆盖 data / file / tool 等其它片段类型。 */
function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Chat 下沉通用展示件示例组。 */
export function ChatDescendedExamples() {
  return (
    <>
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
    </>
  );
}
