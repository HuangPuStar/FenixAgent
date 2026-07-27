import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProps {
  content: string;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:text-text-primary prose-p:text-text-primary prose-strong:text-text-primary prose-li:text-text-primary [&_pre]:bg-surface-2 [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:text-text-primary [&_code]:bg-surface-2 [&_code]:rounded [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-text-primary [&_code]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-text-primary [&_table]:w-full [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:bg-surface-2 [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_img]:max-w-full [&_img]:rounded-lg [&_blockquote]:border-l-4 [&_blockquote]:border-primary/30 [&_blockquote]:pl-4 [&_blockquote]:text-text-muted [&_hr]:border-border [&_a]:text-primary [&_a]:underline">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
