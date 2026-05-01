"use client";

import { Button } from "../ui/button";
import { cn } from "../../src/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  useContext,
  useState,
} from "react";

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
          className
        )}
        {...props}
      >
        {/* Header: language label + copy button */}
        <div className="code-block-header">
          <span className="font-mono">
            {language || "text"}
          </span>
          {children ? (
            <div className="flex items-center gap-1">
              {children}
            </div>
          ) : (
            <CodeBlockCopyButton />
          )}
        </div>

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
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  return (
    <button
      type="button"
      onClick={copyToClipboard}
      className={cn(
        "code-block-copy-btn inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-all duration-200 cursor-pointer",
        isCopied && "copied",
        className
      )}
      {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {isCopied ? (
        <>
          <CheckIcon size={12} />
          <span>已复制</span>
        </>
      ) : (
        <>
          <CopyIcon size={12} />
          <span>复制</span>
        </>
      )}
    </button>
  );
};
