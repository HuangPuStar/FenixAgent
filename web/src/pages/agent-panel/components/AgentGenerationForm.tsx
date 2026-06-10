import { Plus, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NS } from "../../../i18n";

export interface GenerationFormData {
  name: string;
  systemPrompt: string;
  skills: string[];
}

interface AgentGenerationFormProps {
  initialData: GenerationFormData;
  onCreate: (data: GenerationFormData) => Promise<void>;
  loading?: boolean;
}

export function AgentGenerationForm({ initialData, onCreate, loading }: AgentGenerationFormProps) {
  const { t } = useTranslation(NS.AGENT_HOME);
  const [name, setName] = useState(initialData.name);
  const [systemPrompt, setSystemPrompt] = useState(initialData.systemPrompt);
  const [skills, setSkills] = useState(initialData.skills);
  const [newSkill, setNewSkill] = useState("");

  const handleRemoveSkill = useCallback((skill: string) => {
    setSkills((prev) => prev.filter((s) => s !== skill));
  }, []);

  const handleAddSkill = useCallback(() => {
    const trimmed = newSkill.trim();
    if (trimmed && !skills.includes(trimmed)) {
      setSkills((prev) => [...prev, trimmed]);
    }
    setNewSkill("");
  }, [newSkill, skills]);

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
        <div>
          <Label className="mb-1.5 text-xs font-semibold tracking-wide text-gray-700">{t("skillsLabel")}</Label>
          <div className="flex flex-wrap gap-2">
            {skills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-600/20 bg-cyan-600/10 px-3 py-1.5 text-xs font-medium text-cyan-700"
              >
                {skill}
                <button
                  type="button"
                  onClick={() => handleRemoveSkill(skill)}
                  className="text-cyan-600/40 hover:text-cyan-600"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <div className="flex items-center gap-1">
              <Input
                value={newSkill}
                onChange={(e) => setNewSkill(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSkill()}
                placeholder={t("addSkill")}
                className="h-7 w-28 rounded-md border-dashed border-gray-300 bg-gray-50 px-2 text-xs"
              />
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleAddSkill}>
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>

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
