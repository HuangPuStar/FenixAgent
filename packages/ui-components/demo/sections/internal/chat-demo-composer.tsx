/**
 * chat 分区示例：输入岛层（ChatComposer 全量能力、待发送资产行、上下文占用计、模式选择器）。
 *
 * 输入岛的边界是「一整块区域」：它自己装配命令菜单与附件行，宿主只需注入数据与端口。纯化后的宿主端口
 * 在示例里都用本地实现补齐：`uploadFiles` / `compressImage` 直接返回内存附件，`renderFilePicker`
 * 渲染一个内联文件选择器，`onNotice` 写回提示行 —— 与真实宿主的接入方式一致。
 *
 * 命令菜单的独立形态在 L3（chat-demo-command-menu.tsx）演示：这里只演示它被输入岛装配后的样子。
 */

import {
  Button,
  ChatComposer,
  ComposerAssets,
  ComposerContextMeter,
  type ComposerExternalEvent,
  type ComposerExternalSubscribe,
  type ComposerFileInfo,
  type ComposerFilePickerRenderProps,
  type ComposerQuote,
  type FileAttachment,
  SessionModeSelector,
  type UserMessageImage,
} from "@fenix/ui-components";
import {
  createMockTokenUsage,
  MOCK_AVAILABLE_COMMANDS,
  MOCK_AVAILABLE_MODES,
  MOCK_BOUND_MCPS,
  MOCK_DEFAULT_MODE_ID,
  MOCK_USER_IMAGE_URL,
} from "@fenix/ui-components/chat/mocks/mock-fixtures";
import { useRef, useState } from "react";

/** 上下文用量样本：与命令菜单 / 资产行示例同源（mock 工厂函数，避免静态值失真）。 */
const MOCK_CONTEXT_USAGE = createMockTokenUsage();

/**
 * 待发送图片样本：`data` 是 1×1 PNG 占位——发送路径（`prepareImageContent` → `atob`）
 * 要求 base64 载荷；附件行按 `url ?? data URL` 取展示地址，因此画面上是真实照片。
 */
const DEMO_IMAGE: UserMessageImage = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  url: MOCK_USER_IMAGE_URL,
};

/** 初始待发送附件与引用（受控形态，便于演示「附件行」与移除交互）。 */
const DEMO_ATTACHMENTS: FileAttachment[] = [
  { name: "README.md", path: "packages/ui-components/README.md" },
  { name: "chat-l2.tsx", path: "packages/ui-components/demo/sections/chat-l2.tsx" },
];

const DEMO_QUOTES: ComposerQuote[] = [
  {
    id: "demo-quote-1",
    text: "输入状态半受控：draft / attachments / quotes 传入即由宿主接管。",
    omittedCharacterCount: 0,
  },
];

/** 内联文件选择器候选（renderFilePicker 的演示数据）。 */
const DEMO_PICKER_FILES: ComposerFileInfo[] = [
  {
    name: "chat-l2.tsx",
    path: "packages/ui-components/demo/sections/chat-l2.tsx",
    type: "file",
    size: 6144,
    modifiedAt: Date.now(),
  },
  { name: "web", path: "packages/ui-components/web", type: "dir", size: 0, modifiedAt: Date.now() },
];

/** 上传端口演示实现：不落盘，直接把文件名映射成 workspace 相对路径附件。 */
const demoUploadFiles = async (files: File[]): Promise<FileAttachment[]> =>
  files.map((file) => ({ name: file.name, path: `demo-uploads/${file.name}` }));

/** 压缩端口演示实现：包内不引 browser-image-compression，宿主缺省时按原图编码。 */
const demoCompressImage = async (file: File): Promise<Blob> => file;

/** 内联文件选择器：替代宿主 FilePickerDialog（源实现由 ChatComposer 直接渲染）。 */
function DemoFilePicker({ open, onClose, onSelect }: ComposerFilePickerRenderProps) {
  if (!open) return null;
  return (
    <div className="mb-2 rounded-md border border-border bg-surface-1 p-2">
      <div className="mb-1 text-[11px] text-text-muted">选择一个工作区文件引用</div>
      {DEMO_PICKER_FILES.map((file) => (
        <button
          key={file.path}
          type="button"
          className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-surface-2"
          onClick={() => {
            onSelect(file);
            onClose();
          }}
        >
          {file.name}
        </button>
      ))}
      <button
        type="button"
        className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-text-muted"
        onClick={onClose}
      >
        取消
      </button>
    </div>
  );
}

/** 输入岛示例组。 */
export function ChatComposerExamples() {
  const [attachments, setAttachments] = useState<FileAttachment[]>(DEMO_ATTACHMENTS);
  const [quotes, setQuotes] = useState<ComposerQuote[]>(DEMO_QUOTES);
  const [commandPanelOpen, setCommandPanelOpen] = useState(true);
  const [modeId, setModeId] = useState(MOCK_DEFAULT_MODE_ID);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSubmit, setLastSubmit] = useState<string | null>(null);
  // 模拟 turn 运行态：驱动 isLoading 与 canCancel —— 运行中时同一位置显示停止按钮（onInterrupt）。
  const [isRunning, setIsRunning] = useState(false);
  // 外部输入通道：源实现监听 3 个 window 事件（建议提示词 / 文件树引用 / 聊天引用），
  // 纯化后由宿主注入订阅函数；示例用按钮手动触发，便于观察草稿与资产行的变化。
  const emitRef = useRef<((event: ComposerExternalEvent) => void) | null>(null);
  const [subscribeExternal] = useState<ComposerExternalSubscribe>(
    () => (handler: (event: ComposerExternalEvent) => void) => {
      emitRef.current = handler;
      return () => {
        emitRef.current = null;
      };
    },
  );

  return (
    <>
      <div className="demo-example">
        <h2 className="demo-example-title">ChatComposer（命令菜单 + 附件行 + 上下文计 + 模式切换）</h2>
        <ChatComposer
          commands={MOCK_AVAILABLE_COMMANDS}
          mcps={MOCK_BOUND_MCPS}
          contextUsage={MOCK_CONTEXT_USAGE}
          availableModes={MOCK_AVAILABLE_MODES}
          currentModeId={modeId}
          onModeChange={setModeId}
          modelName="Claude Sonnet 4.5"
          supportsImages
          isLoading={isRunning}
          canCancel={isRunning}
          showNewSession
          onNewSession={() => setNotice("已请求新建会话")}
          onInterrupt={() => {
            setIsRunning(false);
            setNotice("已请求中断本轮 turn");
          }}
          uploadFiles={demoUploadFiles}
          compressImage={demoCompressImage}
          renderFilePicker={(props) => <DemoFilePicker {...props} />}
          subscribeExternal={subscribeExternal}
          onNotice={(composerNotice) => setNotice(`${composerNotice.level}: ${composerNotice.message}`)}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          quotes={quotes}
          onQuotesChange={setQuotes}
          commandPanelOpen={commandPanelOpen}
          onCommandPanelOpenChange={setCommandPanelOpen}
          onSubmit={(message) => {
            setLastSubmit(message.text);
            setAttachments([]);
            setQuotes([]);
          }}
          placeholder="输入消息，或输入 / 打开命令菜单…"
        />
        <p className="demo-hint">
          {lastSubmit === null
            ? "命令面板默认展开；发送、上传与新建会话的回调结果会显示在这里。"
            : `已提交：${lastSubmit}（附件与引用已清空）`}
        </p>
        <p className="demo-hint">{notice ?? "等待交互…"}</p>
        <div className="demo-row mt-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              emitRef.current?.({
                type: "suggested-prompt",
                prompt: "用一句话说明 onPreviewFile 的宿主契约",
              })
            }
          >
            注入建议提示词
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              emitRef.current?.({
                type: "file-reference",
                file: { name: "README.md", path: "packages/ui-components/README.md" },
              })
            }
          >
            引用工作区文件
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => emitRef.current?.({ type: "quote", quote: { text: "引用一段消息正文用于本轮上下文。" } })}
          >
            注入聊天引用
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setIsRunning((running) => !running)}>
            {isRunning ? "结束模拟 turn" : "模拟 turn 运行中"}
          </Button>
        </div>
        <p className="demo-hint">
          三个按钮分别走 subscribeExternal 的三类外部事件，效果与源宿主的 window 事件一致； 「模拟 turn
          运行中」会把发送按钮切成停止按钮（canCancel / isLoading）。
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">ComposerAssets（图片 / 文件 / 引用）</h2>
        <ComposerAssets
          images={[DEMO_IMAGE]}
          files={attachments}
          quotes={quotes}
          onRemoveImage={() => setNotice("已移除图片")}
          onRemoveFile={(path) => setAttachments((current) => current.filter((file) => file.path !== path))}
          onRemoveQuote={(id) => setQuotes((current) => current.filter((quote) => quote.id !== id))}
        />
        <p className="demo-hint">移除文件或引用后，上方的 ChatComposer 中对应资产同步消失（同一份受控状态）。</p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">ComposerContextMeter / SessionModeSelector</h2>
        <div className="demo-row">
          <ComposerContextMeter usage={MOCK_CONTEXT_USAGE} />
          <ComposerContextMeter usage={{ totalTokens: 12_800 }} />
          <SessionModeSelector modes={MOCK_AVAILABLE_MODES} currentModeId={modeId} onModeChange={setModeId} />
          <SessionModeSelector modes={MOCK_AVAILABLE_MODES} currentModeId={modeId} onModeChange={setModeId} readOnly />
        </div>
        <p className="demo-hint">占用计在缺少 totalTokens 时不渲染；模式选择器的只读形态退化为静态 chip。</p>
      </div>
    </>
  );
}
