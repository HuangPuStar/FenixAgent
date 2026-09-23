import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { X } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AGENT_HOME_NS } from "../../../i18n/namespace";
import "./AgentGenerationForm.css";

export interface SkillItem {
  id: string;
  name: string;
  description: string;
}

export interface GenerationFormData {
  name: string;
  systemPrompt: string;
  skills: SkillItem[];
}

interface AgentGenerationFormProps {
  initialData: GenerationFormData;
  onCreate: (data: GenerationFormData) => Promise<void>;
  loading?: boolean;
}

/**
 * 名称与 System Prompt 两个字段名共用的标签配方：两处逐字重复（skills 那处多一档下边距，
 * 是既存差异、保持原样），字号 / 字重 / 字距 / 颜色要一起变，抽一处避免只改到一个。
 */
const FIELD_LABEL_CLASS = "mb-1.5 text-xs font-bold tracking-wider text-slate-500";

/** 截取 description 前 N 个字符 */
function truncate(text: string, max: number) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function AgentGenerationForm({ initialData, onCreate, loading }: AgentGenerationFormProps) {
  const { t } = useTranslation(AGENT_HOME_NS);
  const [name, setName] = useState(initialData.name);
  const [systemPrompt, setSystemPrompt] = useState(initialData.systemPrompt);
  const [skills, setSkills] = useState(initialData.skills);

  const handleRemoveSkill = useCallback((skillId: string) => {
    setSkills((prev) => prev.filter((s) => s.id !== skillId));
  }, []);

  const handleSubmit = useCallback(async () => {
    try {
      await onCreate({ name, systemPrompt, skills });
    } catch (err) {
      toast.error(t("createFailed"));
      console.error(err);
    }
  }, [name, systemPrompt, skills, onCreate, t]);

  return (
    <div className="agent-generation-form w-full">
      <div className="flex flex-col gap-5">
        {/* 名称 */}
        <div>
          <Label className={FIELD_LABEL_CLASS}>{t("nameLabel")}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-11 rounded-lg border-slate-900/10 bg-slate-100 text-sm text-slate-900 shadow-none transition-colors focus-visible:border-blue-600 focus-visible:ring-3 focus-visible:ring-blue-600/10"
          />
        </div>

        {/* System Prompt */}
        <div>
          <Label className={FIELD_LABEL_CLASS}>{t("promptLabel")}</Label>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            className="min-h-28 rounded-lg border-slate-900/10 bg-slate-100 text-sm leading-relaxed text-slate-900 shadow-none transition-colors focus-visible:border-blue-600 focus-visible:ring-3 focus-visible:ring-blue-600/10"
          />
        </div>

        {/* Skills */}
        {skills.length > 0 && (
          <div>
            <Label className="mb-2 text-xs font-bold tracking-wider text-slate-500">{t("skillsLabel")}</Label>
            <div className="flex flex-wrap gap-2">
              {skills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex max-w-full items-start gap-2 rounded-lg border border-blue-600/15 bg-blue-600/5 px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-blue-600">{skill.name}</span>
                    {skill.description && (
                      <span className="ml-1.5 text-3xs text-slate-500">{truncate(skill.description, 30)}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveSkill(skill.id)}
                    className="mt-0.5 shrink-0 text-blue-600/45 transition-colors hover:text-blue-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 创建按钮 */}
        <Button
          onClick={handleSubmit}
          disabled={loading || !name.trim()}
          className="agent-generation-form-submit mt-1 h-11 rounded-lg bg-gradient-to-r from-blue-600 to-blue-400 px-4 text-sm font-bold tracking-wide text-white transition-all hover:-translate-y-0.5 hover:from-blue-600 hover:to-sky-500 disabled:translate-y-0 disabled:opacity-60"
        >
          {loading ? "..." : t("createButton")}
        </Button>
      </div>
    </div>
  );
}
