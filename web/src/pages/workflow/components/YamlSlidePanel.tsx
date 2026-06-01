import { Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export function YamlSlidePanel({
  yamlOpen,
  yamlText,
  setYamlText,
  setYamlOpen,
  readOnly,
  handleImportYaml,
  syncYaml,
  hasEdits,
}: {
  yamlOpen: boolean;
  yamlText: string;
  setYamlText: (text: string) => void;
  setYamlOpen: (open: boolean) => void;
  readOnly: boolean;
  handleImportYaml: () => void;
  syncYaml: () => string;
  hasEdits: boolean;
}) {
  const { t } = useTranslation("workflows");

  const handleClose = () => {
    if (hasEdits && !readOnly) {
      const apply = window.confirm(t("editor.yaml_unsaved_confirm"));
      if (apply) {
        handleImportYaml();
      }
    }
    setYamlOpen(false);
  };

  return (
    <div className={`wf-yaml-slide ${yamlOpen ? "open" : ""}`}>
      <div className="wf-yaml-slide-header">
        <span className="wf-yaml-slide-title">
          {t("editor.yaml_title")}
          {hasEdits && !readOnly && <span className="ml-1 text-amber-500 text-[10px]">●</span>}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {!readOnly && (
            <button
              type="button"
              className="wf-toolbar-btn"
              onClick={handleImportYaml}
              data-tooltip={t("editor.yaml_tooltip_apply")}
            >
              <Upload size={14} />
            </button>
          )}
          <button type="button" className="wf-toolbar-btn" onClick={handleClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <textarea
        className="wf-yaml-textarea"
        value={yamlText}
        onChange={(e) => setYamlText(e.target.value)}
        spellCheck={false}
        placeholder={t("editor.yaml_placeholder")}
        readOnly={readOnly}
      />
    </div>
  );
}
