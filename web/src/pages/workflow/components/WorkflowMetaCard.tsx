import { useTranslation } from "react-i18next";
import { Textarea } from "@/components/ui/textarea";
import type { WfMeta } from "../yaml-utils";
import { ParamsEditor } from "./ParamsEditor";

export interface WorkflowMetaCardProps {
  readOnly: boolean;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
}

export function WorkflowMetaCard({ readOnly, meta, updateMeta }: WorkflowMetaCardProps) {
  const { t } = useTranslation("workflows");

  return (
    <div className="wf-popover-body">
      {/* 基本信息 */}
      <div className="wf-prop-section">
        <div className="wf-prop-section-title">{t("editor.basic_info")}</div>
        <div className="wf-prop-field-inline">
          <label>{t("editor.schema_version")}</label>
          <input value={meta.schema_version} readOnly />
        </div>
        <div className="wf-prop-field-inline">
          <label>{t("editor.name")}</label>
          <input value={meta.name} onChange={(e) => updateMeta({ name: e.target.value })} readOnly={readOnly} />
        </div>
        <div className="wf-prop-field-block">
          <label>{t("editor.meta_description")}</label>
          <Textarea
            value={meta.description}
            onChange={(e) => updateMeta({ description: e.target.value })}
            placeholder={t("editor.meta_desc_placeholder")}
            rows={2}
            readOnly={readOnly}
          />
        </div>
        <div className="wf-prop-field-inline">
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

      {/* 参数 */}
      <div className="wf-prop-section">
        <div className="wf-prop-section-title">{t("editor.params")}</div>
        <ParamsEditor
          value={meta.params}
          onChange={(val) => updateMeta({ params: val ?? {} })}
          readOnly={readOnly}
          namePlaceholder={t("editor.params_name_placeholder")}
          defaultPlaceholder={t("editor.params_default_placeholder")}
          addLabel={t("editor.params_add")}
        />
      </div>

      {/* Secrets */}
      <div className="wf-prop-section">
        <div className="wf-prop-section-title">{t("editor.secrets")}</div>
        <div className="wf-prop-field-block">
          <label>{t("editor.secrets_env_names")}</label>
          <Textarea
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
