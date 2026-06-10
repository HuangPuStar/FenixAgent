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
    <div className="w-full max-w-[600px] rounded-2xl border border-gray-200/50 bg-white/75 p-6 shadow-sm backdrop-blur-[10px]">
      <div className="flex flex-col gap-5">
        {/* 名称 */}
        <div>
          <Label className="mb-1.5 text-xs font-semibold tracking-wide text-gray-700">{t("nameLabel")}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-xl border-gray-200 bg-gray-50 text-sm"
          />
        </div>

        {/* System Prompt */}
        <div>
          <Label className="mb-1.5 text-xs font-semibold tracking-wide text-gray-700">{t("promptLabel")}</Label>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            className="min-h-[80px] rounded-xl border-gray-200 bg-gray-50 text-sm leading-relaxed"
          />
        </div>

        {/* Skills */}
        {skills.length > 0 && (
          <div>
            <Label className="mb-1.5 text-xs font-semibold tracking-wide text-gray-700">{t("skillsLabel")}</Label>
            <div className="flex flex-col gap-2">
              {skills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex items-start gap-2 rounded-lg border border-cyan-600/15 bg-cyan-600/5 px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-cyan-700">{skill.name}</span>
                    {skill.description && (
                      <span className="ml-1.5 text-[11px] text-cyan-600/60">{truncate(skill.description, 30)}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveSkill(skill.id)}
                    className="mt-0.5 shrink-0 text-cyan-600/40 hover:text-cyan-600"
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
          className="mt-1 rounded-xl bg-gradient-to-r from-cyan-600 to-teal-600 px-4 py-3.5 text-sm font-semibold tracking-wide text-white shadow-[0_4px_16px_rgba(8,145,178,0.25)] hover:from-cyan-700 hover:to-teal-700"
        >
          {loading ? "..." : t("createButton")}
        </Button>
      </div>
    </div>
  );
}
