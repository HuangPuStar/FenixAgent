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
      setHtml(`<pre><code>${escaped}</code></pre>`);
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
    <div className="flex-1 overflow-auto p-4">
      <div
        className="code-preview-view rounded-lg overflow-hidden text-sm [&_pre]:!bg-[#ffffff] [&_pre]:p-4 [&_pre]:m-0 [&_pre]:overflow-auto [&_code]:text-[13px] [&_code]:leading-relaxed"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出的可信 HTML
        dangerouslySetInnerHTML={{ __html: html ?? "" }}
      />
    </div>
  );
}
