import { Check, Clipboard, Square, SquareCheckBig } from "lucide-react";
import { useState } from "react";
import { useDemoTranslation } from "./use-demo-copy";

interface MarkdownShowcaseProps {
  variant?: "full" | "long";
}

const LONG_MARKDOWN_SECTIONS = Array.from({ length: 12 }, (_, index) => ({
  id: `markdown-section-${index + 1}`,
  index: index + 1,
}));

/** Demonstrates the Markdown surface supported by Chat without parsing remote content. */
export function MarkdownShowcase({ variant = "full" }: MarkdownShowcaseProps) {
  return variant === "long" ? <LongMarkdown /> : <FullMarkdown />;
}

function FullMarkdown() {
  const { t } = useDemoTranslation();
  return (
    <div className="chat-demo__markdown">
      <h1>{t("markdown.title")}</h1>
      <p>
        {t("markdown.introBefore")} <strong>{t("markdown.bold")}</strong>, <em>{t("markdown.italic")}</em>,
        <del>{t("markdown.deleted")}</del>, <code>{t("markdown.inlineCode")}</code>, {t("markdown.and")}
        <a href="/ctrl/chat-demo">{t("markdown.link")}</a>.
      </p>
      <blockquote>
        <strong>{t("markdown.quoteTitle")}</strong>
        <p>{t("markdown.quote")}</p>
      </blockquote>
      <h2>{t("markdown.heading")}</h2>
      <ol>
        <li>{t("markdown.ordered1")}</li>
        <li>
          {t("markdown.ordered2")}
          <ul>
            <li>{t("markdown.nested1")}</li>
            <li>{t("markdown.nested2")}</li>
          </ul>
        </li>
        <li>{t("markdown.ordered3")}</li>
      </ol>
      <h3>{t("markdown.taskHeading")}</h3>
      <ul className="chat-demo__task-markdown">
        <li data-checked="true">
          <SquareCheckBig aria-hidden="true" />
          <span className="sr-only">已完成</span>
          {t("markdown.task1")}
        </li>
        <li data-checked="true">
          <SquareCheckBig aria-hidden="true" />
          <span className="sr-only">已完成</span>
          {t("markdown.task2")}
        </li>
        <li>
          <Square aria-hidden="true" />
          <span className="sr-only">未完成</span>
          {t("markdown.task3")}
        </li>
      </ul>
      <MarkdownTable />
      <h2>{t("markdown.codeHeading")}</h2>
      <CodeBlock label={t("markdown.codeLabel")} content={t("markdown.code")} />
      <CodeBlock label={t("markdown.diffLabel")} content={t("markdown.diff")} tone="diff" />
      <h2>{t("markdown.diagramHeading")}</h2>
      <div className="chat-demo__md-diagram" role="img" aria-label={t("markdown.diagramLabel")}>
        <span>{t("markdown.diagramUser")}</span>
        <i>→</i>
        <span>{t("markdown.diagramChat")}</span>
        <i>→</i>
        <span>{t("markdown.diagramAgent")}</span>
      </div>
      <div className="chat-demo__md-math">
        <span>{t("markdown.mathLabel")}</span>
        <code>latency = p95(tool_end − tool_start)</code>
      </div>
      <details>
        <summary>{t("markdown.detailsTitle")}</summary>
        <p>{t("markdown.detailsBody")}</p>
      </details>
      <hr />
      <p className="chat-demo__footnote">
        <sup>1</sup> {t("markdown.footnote")}
      </p>
    </div>
  );
}

function LongMarkdown() {
  const { t } = useDemoTranslation();
  return (
    <div className="chat-demo__markdown chat-demo__markdown--long">
      <h1>{t("longMarkdown.title")}</h1>
      <p>{t("longMarkdown.lead")}</p>
      <blockquote>
        <p>{t("longMarkdown.quote")}</p>
      </blockquote>
      {LONG_MARKDOWN_SECTIONS.map((section) => (
        <section key={section.id}>
          <h2>{t("longMarkdown.sectionTitle", { index: section.index })}</h2>
          <p>{t("longMarkdown.paragraph", { index: section.index })}</p>
          <ul>
            <li>{t("longMarkdown.rule1")}</li>
            <li>{t("longMarkdown.rule2")}</li>
            <li>{t("longMarkdown.rule3")}</li>
          </ul>
          {section.index % 3 === 2 && <MarkdownTable />}
          {section.index % 3 === 0 && (
            <CodeBlock label={t("markdown.codeLabel")} content={t("longMarkdown.code", { index: section.index })} />
          )}
        </section>
      ))}
      <hr />
      <p>{t("longMarkdown.outro")}</p>
    </div>
  );
}

function MarkdownTable() {
  const { t } = useDemoTranslation();
  return (
    <div className="chat-demo__table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t("markdown.tableApi")}</th>
            <th>{t("markdown.tableBefore")}</th>
            <th>{t("markdown.tableAfter")}</th>
            <th>{t("markdown.tableStatus")}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{t("markdown.tableChat")}</td>
            <td>
              <code>POST /v1/chat</code>
            </td>
            <td>
              <code>POST /web/sessions</code>
            </td>
            <td>{t("markdown.ready")}</td>
          </tr>
          <tr>
            <td>{t("markdown.tableEvents")}</td>
            <td>
              <code>GET /v1/events</code>
            </td>
            <td>
              <code>GET /web/events</code>
            </td>
            <td>{t("markdown.review")}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({ label, content, tone }: { label: string; content: string; tone?: "diff" }) {
  const { t } = useDemoTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="chat-demo__code-block" data-tone={tone}>
      <div>
        <span>{label}</span>
        <button
          type="button"
          onClick={() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check /> : <Clipboard />}
          {copied ? t("controls.copied") : t("controls.copy")}
        </button>
      </div>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}
