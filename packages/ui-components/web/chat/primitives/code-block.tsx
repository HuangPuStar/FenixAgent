import "./code-block.css";

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

/*
 * 排版（原 `code-block.css`，2026-09-28 伪深层清理 → 同日令牌层裁定）：`<pre>` / `<code>` 的 12px
 * 字号由 `className` 的 `text-xs` 表达（令牌层 `--text-xs: 12px`，工具类即设计值）；复制按钮的 11px
 * 留在同目录 `code-block.css`，第三批补齐 `--text-11` 档后改 token 引用 `var(--text-11)`（表内不留
 * px 字面量）。
 * 例外说明：
 * - `<pre>` 的 `line-height: 1.6` 无标准 `leading-*` 档（`leading-<数字>` 走间距刻度，语义不符），
 *   按仓库既有写法保留为任意值 `leading-[1.6]`——其值不含长度单位，不命中 FCP-WEB-01；
 * - `<code>` 的两条与 `<pre>` 同值（原样式表里本就是重复声明：preflight 的 `code { font-size: 1em }`
 *   让它继承 `<pre>` 的字号），仍逐条写在 `<code>` 上，语义元素自身保持独立成立。
 */

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

        {/* Code area — font-mono 12px pre-wrap（`text-xs` = 令牌层 `--text-xs: 12px`，`leading-[1.6]` = 原 `line-height: 1.6`） */}
        <div className="overflow-x-auto p-3">
          <pre className="code-block-pre m-0 whitespace-pre-wrap break-words font-mono text-xs leading-[1.6]">
            <code className="code-block-code text-xs leading-[1.6]">{code}</code>
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
        // 字号是 `code-block.css` 的 `font-size: var(--text-11)`（11px 档，2026-09-28 第三批补齐后
        // 改 token 引用形态，表内不留 px 字面量）。
        "code-block-copy-btn inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium transition-all duration-200 cursor-pointer",
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
