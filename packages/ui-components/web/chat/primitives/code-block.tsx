import { CheckIcon, CopyIcon } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  useContext,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { copyTextToClipboard } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import type { Button } from "../../ui/button";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
};

type CodeBlockContextType = {
  code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  return (
    <CodeBlockContext.Provider value={{ code }}>
      <div
        className={cn(
          "code-block-wrapper group relative w-full overflow-hidden rounded-lg border border-border-subtle bg-surface-2 text-foreground",
          className,
        )}
        {...props}
      >
        {/* Header: language label + copy button */}
        {/* <div className="code-block-header">
          <span className="font-mono">{language || "text"}</span>
          {children ? <div className="flex items-center gap-1">{children}</div> : <CodeBlockCopyButton />}
        </div> */}

        {/* Code area — font-mono 12px pre-wrap */}
        <div className="overflow-x-auto p-3">
          <pre className="m-0 text-[12px] whitespace-pre-wrap break-words font-mono leading-[1.6]">
            <code className="text-[12px]">{code}</code>
          </pre>
        </div>
      </div>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 1500,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = async () => {
    // 判空与 `writeText` 调用收进 `lib/clipboard`：原语在 API 缺失与写入被拒时都回传 `false`，
    // 调用方只判断结果（此处结果经 `onError` 端口上报，反馈形态仍由调用方决定）。
    if (!(await copyTextToClipboard(code))) {
      onError?.(new Error("Clipboard write failed"));
      return;
    }

    setIsCopied(true);
    onCopy?.();
    setTimeout(() => setIsCopied(false), timeout);
  };

  return (
    <button
      type="button"
      onClick={copyToClipboard}
      className={cn(
        "code-block-copy-btn inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-all duration-200 cursor-pointer",
        isCopied && "copied",
        className,
      )}
      {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {isCopied ? (
        <>
          <CheckIcon size={12} />
          <span>{t("codeBlock.copied")}</span>
        </>
      ) : (
        <>
          <CopyIcon size={12} />
          <span>{t("codeBlock.copy")}</span>
        </>
      )}
    </button>
  );
};
