import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { NodeOutput } from "../../../api/workflow-engine";

export function NodeOutputView({ output }: { output: NodeOutput }) {
  const { t } = useTranslation("workflows");
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(output.stdout).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <div
        style={{
          padding: "5px 10px",
          borderBottom: "1px solid #f3f4f6",
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: 9,
          color: "#6b7280",
        }}
      >
        <span>exit_code: {output.exit_code}</span>
        {output.size != null && <span>· {output.size}B</span>}
        {output.ref && <span style={{ color: "#f59e0b" }}>· {t("editor.large_output_ref")}</span>}
        <button
          type="button"
          onClick={handleCopy}
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 2,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#6b7280",
            fontSize: 9,
          }}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />} {copied ? t("editor.copied") : t("editor.copy")}
        </button>
      </div>
      {output.stdout ? (
        <pre
          style={{
            padding: 10,
            margin: 0,
            fontSize: 10,
            lineHeight: 1.5,
            fontFamily: "ui-monospace, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            color: "#1f2937",
            background: "#fafafa",
          }}
        >
          {output.stdout}
        </pre>
      ) : (
        <div style={{ padding: 14, textAlign: "center", color: "#d1d5db" }}>{t("editor.no_stdout")}</div>
      )}
      {output.json !== undefined && output.json !== null && (
        <div style={{ borderTop: "1px solid #f3f4f6" }}>
          <div style={{ padding: "5px 10px", fontSize: 9, color: "#6b7280", fontWeight: 500 }}>
            {t("editor.json_output")}
          </div>
          <pre
            style={{
              padding: 10,
              margin: 0,
              fontSize: 10,
              lineHeight: 1.5,
              fontFamily: "ui-monospace, monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "#6b7280",
            }}
          >
            {JSON.stringify(output.json, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
