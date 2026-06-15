import { X } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NS } from "../../../i18n";

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

/** 截取 description 前 N 个字符 */
function truncate(text: string, max: number) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function AgentGenerationForm({ initialData, onCreate, loading }: AgentGenerationFormProps) {
  const { t } = useTranslation(NS.AGENT_HOME);
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
          <Label className="mb-1.5 text-xs font-bold tracking-[0.04em] text-[#5a6785]">{t("nameLabel")}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-11 rounded-lg border-[rgba(12,26,58,0.1)] bg-[#edf0f6] text-sm text-[#0c1a3a] shadow-none transition-colors focus-visible:border-[#0f6bff] focus-visible:ring-[3px] focus-visible:ring-[#0f6bff]/10"
          />
        </div>

        {/* System Prompt */}
        <div>
          <Label className="mb-1.5 text-xs font-bold tracking-[0.04em] text-[#5a6785]">{t("promptLabel")}</Label>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            className="min-h-[112px] rounded-lg border-[rgba(12,26,58,0.1)] bg-[#edf0f6] text-sm leading-relaxed text-[#0c1a3a] shadow-none transition-colors focus-visible:border-[#0f6bff] focus-visible:ring-[3px] focus-visible:ring-[#0f6bff]/10"
          />
        </div>

        {/* Skills */}
        {skills.length > 0 && (
          <div>
            <Label className="mb-2 text-xs font-bold tracking-[0.04em] text-[#5a6785]">{t("skillsLabel")}</Label>
            <div className="flex flex-wrap gap-2">
              {skills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex max-w-full items-start gap-2 rounded-lg border border-[#0f6bff]/15 bg-[#0f6bff]/5 px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-[#0f6bff]">{skill.name}</span>
                    {skill.description && (
                      <span className="ml-1.5 text-[11px] text-[#5a6785]">{truncate(skill.description, 30)}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveSkill(skill.id)}
                    className="mt-0.5 shrink-0 text-[#0f6bff]/45 transition-colors hover:text-[#0f6bff]"
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
          className="mt-1 h-11 rounded-lg bg-gradient-to-r from-[#0f6bff] to-[#32b1ff] px-4 text-sm font-bold tracking-wide text-white shadow-[0_4px_14px_rgba(15,107,255,0.3)] transition-all hover:-translate-y-0.5 hover:from-[#0b5ee8] hover:to-[#219eea] disabled:translate-y-0 disabled:opacity-60"
        >
          {loading ? "..." : t("createButton")}
        </Button>
      </div>
    </div>
  );
}
