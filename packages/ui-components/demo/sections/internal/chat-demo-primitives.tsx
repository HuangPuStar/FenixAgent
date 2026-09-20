import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
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
import { useState } from "react";

/**
 * Chat L4 示例组：会话交互基元 —— PromptInput / Reasoning / Tool（含 ToolPermissionButtons），
 * 对应包内 `web/chat/primitives`（即源 `web/ai-elements` 组改名后的形态），由 chat-l4.tsx 组装。
 *
 * 同属 chat/primitives 的消息展示件（Conversation / Message / MessageResponse / MessageAttachments）
 * 不带会话 / 工具 / 推理语义，已下沉到 Base UI P3 的 chat-descended.tsx；这一层只留必须认识
 * 会话交互形状的基元：提示词输入、推理块与工具调用审批。
 *
 * 这一层不认识会话、也不取数：示例全部使用本地静态数据，不访问任何后端；
 * PromptInput 与 ToolPermissionButtons 的交互回调只把载荷打到控制台与提示行，用于验证回调确实触发。
 */

const SAMPLE_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

export function ChatPrimitivesExamples() {
  const [submittedText, setSubmittedText] = useState<string | null>(null);
  const [permissionReply, setPermissionReply] = useState<string | null>(null);

  return (
    <>
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
    </>
  );
}
