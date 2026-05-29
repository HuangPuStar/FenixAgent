import { useTranslation } from "react-i18next";
import type { WfMeta } from "../yaml-utils";

export interface WorkflowMetaCardProps {
  readOnly: boolean;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
}

export function WorkflowMetaCard({ readOnly, meta, updateMeta }: WorkflowMetaCardProps) {
  const { t } = useTranslation("workflows");

  return (
    <div className="wf-popover-body">
      <div className="wf-prop-section">
        <div className="wf-prop-section-title">{t("editor.basic_info")}</div>
        <div className="wf-prop-field">
          <label>{t("editor.schema_version")}</label>
          <input value={meta.schema_version} readOnly />
        </div>
        <div className="wf-prop-field">
          <label>{t("editor.name")}</label>
          <input value={meta.name} onChange={(e) => updateMeta({ name: e.target.value })} readOnly={readOnly} />
        </div>
        <div className="wf-prop-field">
          <label>{t("editor.meta_description")}</label>
          <textarea
            value={meta.description}
            onChange={(e) => updateMeta({ description: e.target.value })}
            placeholder={t("editor.meta_desc_placeholder")}
            rows={2}
            readOnly={readOnly}
          />
        </div>
        <div className="wf-prop-field">
          <label>{t("editor.timeout_seconds")}</label>
          <input
            type="number"
            value={meta.timeout}
            onChange={(e) => updateMeta({ timeout: e.target.value ? Number(e.target.value) : 300 })}
            placeholder="300"
            readOnly={readOnly}
          />
        </div>
      </div>

      <div className="wf-prop-section">
        <div className="wf-prop-section-title">{t("editor.params")}</div>
        <div className="wf-prop-field">
          <label>{t("editor.params_json")}</label>
          <textarea
            value={Object.keys(meta.params).length ? JSON.stringify(meta.params, null, 2) : ""}
            onChange={(e) => {
              try {
                const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : {};
                updateMeta({ params: parsed });
              } catch {
                // 用户还在编辑，暂不更新
              }
            }}
            placeholder='{"name": {"type": "string", "default": "World"}}'
            rows={3}
            readOnly={readOnly}
          />
        </div>
      </div>

      <div className="wf-prop-section">
        <div className="wf-prop-section-title">{t("editor.secrets")}</div>
        <div className="wf-prop-field">
          <label>{t("editor.secrets_env_names")}</label>
          <textarea
            value={meta.secrets.join("\n")}
            onChange={(e) =>
              updateMeta({
                secrets: e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="API_KEY&#10;DATABASE_URL"
            rows={2}
            readOnly={readOnly}
          />
        </div>
      </div>
    </div>
  );
}
