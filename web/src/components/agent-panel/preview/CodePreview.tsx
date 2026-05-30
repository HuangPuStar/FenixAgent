import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import { getShikiLanguage } from "./utils";

interface CodePreviewProps {
  content: string;
  filePath: string;
}

export function CodePreview({ content, filePath }: CodePreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const highlight = useCallback(async () => {
    setLoading(true);
    try {
      const lang = getShikiLanguage(filePath) ?? "text";
      const result = await codeToHtml(content, {
        lang,
        theme: "github-light-default",
      });
      setHtml(result);
    } catch {
      const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      setHtml(escaped);
    } finally {
      setLoading(false);
    }
  }, [content, filePath]);

  useEffect(() => {
    highlight();
  }, [highlight]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <style>{`
        .shiki-preview {
          counter-reset: line;
          font-size: 12px;
          line-height: 1.6;
          padding: 16px;
          margin: 0;
          white-space: nowrap;
          background: transparent !important;
        }
        .shiki-preview .line {
          counter-increment: line;
          display: block;
          padding-left: 3.5em;
          position: relative;
          min-height: 1.6em;
        }
        .shiki-preview .line::before {
          content: counter(line);
          position: absolute;
          left: 0;
          width: 2.5em;
          text-align: right;
          color: rgba(0, 0, 0, 0.25);
          user-select: none;
          font-variant-numeric: tabular-nums;
        }
      `}</style>
      {/* eslint-disable-next-line react/no-danger */}
      <pre
        className="shiki-preview font-mono whitespace-nowrap"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出的可信 HTML
        dangerouslySetInnerHTML={{ __html: html ?? "" }}
      />
    </div>
  );
}
