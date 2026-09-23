import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { Upload, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function YamlSlidePanel({
  yamlOpen,
  yamlText,
  setYamlText,
  setYamlOpen,
  readOnly,
  handleImportYaml,
  syncYaml: _syncYaml,
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
  // 关闭前的二次确认。原实现用同步的 window.confirm，确认与关闭写在同一条同步流里；
  // ConfirmDialog 是受控的异步弹窗，因此把「待确认的关闭」显式挂起。原 window.confirm 的三条分支映射为：
  //   ① 无未保存编辑（或只读）→ 不弹窗、不挂起，直接 setYamlOpen(false)（见 handleClose）；
  //   ② 点「确认」→ 先 handleImportYaml() 应用，再关闭弹窗与面板；
  //   ③ 点「取消」/ESC → 不应用，直接关闭弹窗与面板（对应原 confirm 返回 false 后同样落到 setYamlOpen(false)）。
  // 即 ②③ 都关闭面板，差别只在是否先应用——与改造前「取消 = 放弃编辑并关闭」的语义一致。
  // （AlertDialog 默认屏蔽遮罩点击，故 ③ 只有「取消」与 ESC 两条入口，不存在点遮罩静默丢弃编辑的情况。）
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  const handleClose = () => {
    if (hasEdits && !readOnly) {
      setCloseConfirmOpen(true);
      return;
    }
    setYamlOpen(false);
  };

  return (
    <div className={`wf-yaml-slide ${yamlOpen ? "open" : ""}`}>
      <div className="wf-yaml-slide-header">
        <span className="wf-yaml-slide-title">
          {t("editor.yaml_title")}
          {hasEdits && !readOnly && <span className="ml-1 text-amber-500 text-3xs">●</span>}
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

      {/* 关闭面板前的二次确认：确认=应用后关闭，取消=丢弃并关闭（分支映射见上方状态注释） */}
      <ConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={(open) => {
          if (open) return;
          // 取消 / ESC：不应用编辑，丢弃并关闭面板。
          setCloseConfirmOpen(false);
          setYamlOpen(false);
        }}
        title={t("editor.yaml_unsaved_title")}
        description={t("editor.yaml_unsaved_confirm")}
        onConfirm={() => {
          // 确认：先应用 YAML，再关闭弹窗与面板。
          handleImportYaml();
          setCloseConfirmOpen(false);
          setYamlOpen(false);
        }}
      />
    </div>
  );
}
