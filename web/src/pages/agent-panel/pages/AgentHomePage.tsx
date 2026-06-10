import { useNavigate } from "@tanstack/react-router";
import { BookOpen, FileCode, FileText, Pencil, Search, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentApi, envApi, modelApi } from "@/src/api/sdk";
import type { AgentTemplate } from "../../../../../packages/sdk/src/modules/config";
import { NS } from "../../../i18n";
import { dispatchConfigChange } from "../../../lib/config-events";
import type { GenerationFormData } from "../components/AgentGenerationForm";
import { AgentGenerationForm } from "../components/AgentGenerationForm";

// 模板卡片图标色系
const TEMPLATE_COLORS = [
  { from: "#0891b2", to: "#22d3ee", shadow: "rgba(8,145,178,0.25)" },
  { from: "#0d9488", to: "#2dd4bf", shadow: "rgba(13,148,136,0.25)" },
  { from: "#d97706", to: "#fbbf24", shadow: "rgba(217,119,6,0.25)" },
  { from: "#2563eb", to: "#60a5fa", shadow: "rgba(37,99,235,0.25)" },
  { from: "#059669", to: "#34d399", shadow: "rgba(5,150,105,0.25)" },
  { from: "#0284c7", to: "#38bdf8", shadow: "rgba(2,132,199,0.25)" },
];

// 模板卡片图标列表
const TEMPLATE_ICONS = [Pencil, FileText, Search, FileCode, Wand2, BookOpen];

type PagePhase = "idle" | "generating" | "form";

/** Agent 首页：AI 智能生成 + 模板一键创建 */
export function AgentHomePage() {
  const { t } = useTranslation(NS.AGENT_HOME);
  const navigate = useNavigate();

  // 随机选择标题（挂载时决定）
  const titleKey = useMemo(() => {
    const keys = ["title1", "title2", "title3"] as const;
    return keys[Math.floor(Math.random() * keys.length)];
  }, []);

  const [phase, setPhase] = useState<PagePhase>("idle");
  const [inputValue, setInputValue] = useState("");
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [generationResult, setGenerationResult] = useState<GenerationFormData | null>(null);
  const [creating, setCreating] = useState(false);
  const [templateCreating, setTemplateCreating] = useState<string | null>(null);

  // 加载模板列表
  useEffect(() => {
    agentApi
      .templates()
      .then((res) => {
        if (res.ok && res.data?.templates) {
          setTemplates(res.data.templates);
        }
      })
      .catch(() => {});
  }, []);

  // Enter 提交，调用 AI 生成
  const handleSubmit = useCallback(async () => {
    const prompt = inputValue.trim();
    if (!prompt) return;

    setPhase("generating");
    try {
      const response = await fetch("/web/agent-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ prompt }),
      });
      const json = (await response.json()) as {
        success: boolean;
        data?: { name: string; systemPrompt: string; skills: Array<{ id: string; name: string; description: string }> };
        error?: { message: string };
      };

      if (json.success && json.data) {
        setGenerationResult(json.data);
        setPhase("form");
      } else {
        toast.error(t("generationFailed"));
        setPhase("idle");
      }
    } catch {
      toast.error(t("generationFailed"));
      setPhase("idle");
    }
  }, [inputValue, t]);

  /** 创建 agent 配置 → 创建 environment → 跳转聊天页 */
  const createAndNavigate = useCallback(
    async (agentName: string, payload: Record<string, unknown>) => {
      // 0. 获取第一个可用模型，没有则报错
      const { data: modelData } = await modelApi.get();
      const available = (modelData as { available?: Array<{ id: string }> } | undefined)?.available;
      const firstModelId = Array.isArray(available) && available.length > 0 ? available[0].id : undefined;
      if (!firstModelId) {
        toast.error(t("noModel"));
        return;
      }

      // 1. 创建 agent 配置（已存在也继续）
      const agentRes = await agentApi.create(agentName, { ...payload, modelId: firstModelId });
      const isAlreadyExists = !agentRes.ok && (agentRes as any).error?.code === "ALREADY_EXISTS";
      if (!agentRes.ok && !isAlreadyExists) {
        toast.error(t("createFailed"));
        return;
      }

      // 2. 拿到 agent 的 UUID
      const agentData = agentRes.data as { id?: string } | undefined;
      let agentConfigId = agentData?.id;
      // 已存在时 create 不返回 id，需要查一次
      if (!agentConfigId) {
        const { data: detail } = await agentApi.get(agentName);
        agentConfigId = (detail as { id?: string } | undefined)?.id;
      }
      if (!agentConfigId) {
        toast.error(t("createFailed"));
        return;
      }

      // 刷新左侧智能体列表
      dispatchConfigChange("agents");

      // 3. 创建 environment（autoStart: true 自动启动实例）
      const { data: newEnv } = await envApi.create({
        name: `env-${agentConfigId.slice(0, 8)}`,
        agentConfigId,
        autoStart: true,
      });
      const envId = (newEnv as { id?: string } | undefined)?.id;
      if (!envId) {
        toast.error(t("createFailed"));
        return;
      }

      // 4. 跳转聊天页（路由参数是 environment ID）
      void navigate({ to: "/agent/chat/$agentId", params: { agentId: envId } });
    },
    [navigate, t],
  );

  // 创建智能体（AI 生成流程）
  const handleCreateFromGeneration = useCallback(
    async (data: GenerationFormData) => {
      setCreating(true);
      try {
        await createAndNavigate(data.name, {
          prompt: data.systemPrompt,
          skillIds: data.skills.map((s) => s.id),
        });
      } catch {
        toast.error(t("createFailed"));
      } finally {
        setCreating(false);
      }
    },
    [createAndNavigate, t],
  );

  // 模板一键创建
  const handleTemplateClick = useCallback(
    async (template: AgentTemplate) => {
      setTemplateCreating(template.id);
      try {
        await createAndNavigate(template.name, {
          prompt: template.prompt,
          skillIds: template.skills,
        });
      } catch {
        toast.error(t("createFailed"));
      } finally {
        setTemplateCreating(null);
      }
    },
    [createAndNavigate, t],
  );

  // 返回 idle 状态
  const handleReset = useCallback(() => {
    setPhase("idle");
    setGenerationResult(null);
  }, []);

  const showSubtitle = phase !== "form";

  return (
    <div className="relative flex flex-1 flex-col items-center overflow-auto bg-white">
      {/* 装饰光斑：纯白底上极淡的渐变点缀 */}
      <div className="pointer-events-none absolute left-[10%] top-[8%] h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle,rgba(6,182,212,0.04)_0%,transparent_60%)]" />
      <div className="pointer-events-none absolute bottom-[8%] right-[8%] h-[350px] w-[350px] rounded-full bg-[radial-gradient(circle,rgba(217,119,6,0.03)_0%,transparent_60%)]" />
      <div className="pointer-events-none absolute left-[50%] top-[40%] h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(37,99,235,0.02)_0%,transparent_55%)]" />

      {/* 内容区域 */}
      <div
        className="relative z-10 flex flex-col items-center justify-center gap-8 px-8 py-16"
        style={{ minHeight: "calc(100vh - 56px)" }}
      >
        {/* 标题 + 波浪装饰 */}
        <div className="flex flex-col items-center text-center">
          <h1 className="text-[36px] font-extrabold tracking-[2px] text-gray-800 leading-tight">{t(titleKey)}</h1>
          {/* 波浪装饰 SVG */}
          <svg width="220" height="8" viewBox="0 0 150 8" fill="none" className="-mt-[2px]">
            <defs>
              <linearGradient id="title-wave" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#374151" stopOpacity="0.4" />
                <stop offset="50%" stopColor="#0891b2" stopOpacity="0.4" />
                <stop offset="100%" stopColor="#d97706" stopOpacity="0.3" />
              </linearGradient>
            </defs>
            <path
              d="M 1.201 6.67 C 5.796 6.67 5.796 1.859 10.426 1.859 C 15.021 1.859 15.021 6.67 19.652 6.67 C 24.246 6.67 24.246 1.859 28.877 1.859 C 33.471 1.859 33.471 6.67 38.102 6.67 C 42.697 6.67 42.697 1.859 47.327 1.859 C 51.922 1.859 51.922 6.67 56.552 6.67 C 61.147 6.67 61.147 1.859 65.777 1.859 C 70.372 1.859 70.372 6.67 75.002 6.67 C 79.597 6.67 79.597 1.859 84.227 1.859 C 88.822 1.859 88.822 6.67 93.452 6.67 C 98.047 6.67 98.047 1.859 102.677 1.859 C 107.272 1.859 107.272 6.67 111.902 6.67 C 116.497 6.67 116.497 1.859 121.128 1.859 C 125.722 1.859 125.722 6.67 130.353 6.67 C 134.947 6.67 134.947 1.859 139.578 1.859 C 144.173 1.859 144.173 6.67 148.803 6.67"
              stroke="url(#title-wave)"
              strokeWidth="2.33"
              strokeLinecap="round"
            />
          </svg>
          {showSubtitle && <p className="mt-2.5 text-[15px] tracking-[1px] text-[#9ca3af]">{t("subtitle")}</p>}
        </div>

        {/* 输入框区域 */}
        <div className="w-full max-w-[600px]">
          {phase === "idle" && (
            /* 阶段 1：流光输入框 */
            <div className="glow-border-wrapper">
              <div className="glow-border-inner">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                  placeholder={t("inputPlaceholder")}
                  className="w-full bg-transparent text-[15px] text-gray-800 outline-none placeholder:text-[#9ca3af]"
                />
                <span className="shrink-0 text-[13px] text-[#9ca3af]">{t("enterHint")}</span>
              </div>
            </div>
          )}

          {(phase === "generating" || phase === "form") && (
            /* 阶段 2/3：已提交的输入框 */
            <div className="rounded-[18px] border-[1.5px] border-gray-200/60 bg-white/75 px-[22px] py-[14px]">
              <div className="flex items-center gap-3">
                <span className="flex-1 text-[14px] text-gray-700">{inputValue}</span>
                <button
                  type="button"
                  onClick={handleReset}
                  className="shrink-0 text-[12px] font-medium text-[#0891b2] hover:underline"
                >
                  {t("editInput")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Loading 状态（阶段 2） */}
        {phase === "generating" && (
          <div className="w-full max-w-[600px] rounded-2xl border border-gray-200/40 bg-white/60 p-6 backdrop-blur-[8px] flex flex-col items-center gap-3.5">
            <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-cyan-600/15 border-t-[#0891b2]" />
            <div className="text-[14px] font-medium text-gray-600">{t("loadingTitle")}</div>
            <div className="text-[12px] text-[#9ca3af]">{t("loadingSubtitle")}</div>
          </div>
        )}

        {/* 表单（阶段 3） */}
        {phase === "form" && generationResult && (
          <AgentGenerationForm
            initialData={generationResult}
            onCreate={handleCreateFromGeneration}
            loading={creating}
          />
        )}

        {/* 模板卡片（idle 阶段显示） */}
        {phase === "idle" && (
          <>
            {/* 分隔线 */}
            <div className="flex items-center gap-2.5">
              <div className="h-px w-[60px] bg-gradient-to-r from-transparent to-gray-300/30" />
              <span className="text-[12px] font-medium tracking-[1px] text-[#b0b8c4]">{t("orTemplate")}</span>
              <div className="h-px w-[60px] bg-gradient-to-l from-transparent to-gray-300/30" />
            </div>

            {/* 模板网格：两排各 4 个 */}
            <div className="grid max-w-[880px] grid-cols-4 gap-3">
              {templates.map((template, index) => {
                const color = TEMPLATE_COLORS[index % TEMPLATE_COLORS.length];
                const Icon = TEMPLATE_ICONS[index % TEMPLATE_ICONS.length];
                const isLoading = templateCreating === template.id;

                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => void handleTemplateClick(template)}
                    disabled={!!templateCreating}
                    className="flex items-center gap-3 rounded-xl border border-gray-200/50 bg-white p-3.5 text-left shadow-[0_2px_16px_rgba(0,0,0,0.04)] transition-all hover:shadow-[0_4px_20px_rgba(0,0,0,0.08)] disabled:opacity-60"
                  >
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
                      style={{
                        background: `linear-gradient(135deg, ${color.from}, ${color.to})`,
                        boxShadow: `0 4px 14px ${color.shadow}`,
                      }}
                    >
                      <Icon className="h-4 w-4 text-white" />
                    </div>
                    <div>
                      <div className="text-[13px] font-semibold text-gray-800">{template.name}</div>
                      <div className="mt-0.5 text-[11px] text-[#9ca3af]">{template.description}</div>
                    </div>
                    {isLoading && (
                      <div className="ml-auto h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-cyan-600/15 border-t-[#0891b2]" />
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* 流光边框动画样式 */}
      <style>{`
        @keyframes glow-flow {
          0% { background-position: 0% 50%; }
          100% { background-position: 200% 50%; }
        }
        @keyframes shadow-flow {
          0% { box-shadow: 0 0 20px rgba(37,99,235,0.08), 0 4px 24px rgba(0,0,0,0.03); }
          25% { box-shadow: 0 0 20px rgba(6,182,212,0.1), 0 4px 24px rgba(0,0,0,0.03); }
          50% { box-shadow: 0 0 20px rgba(13,148,136,0.1), 0 4px 24px rgba(0,0,0,0.03); }
          75% { box-shadow: 0 0 20px rgba(217,119,6,0.08), 0 4px 24px rgba(0,0,0,0.03); }
          100% { box-shadow: 0 0 20px rgba(37,99,235,0.08), 0 4px 24px rgba(0,0,0,0.03); }
        }
        .glow-border-wrapper {
          background: linear-gradient(90deg, rgba(37,99,235,0.14), rgba(6,182,212,0.18), rgba(13,148,136,0.18), rgba(217,119,6,0.14), rgba(37,99,235,0.14));
          background-size: 200% 100%;
          animation: glow-flow 2s linear infinite;
          padding: 1.5px;
          border-radius: 18px;
        }
        .glow-border-inner {
          background: rgba(255,255,255,0.92);
          backdrop-filter: blur(16px);
          border-radius: 17px;
          padding: 20px 24px;
          display: flex;
          align-items: center;
          gap: 16px;
          animation: shadow-flow 2s linear infinite;
        }
      `}</style>
    </div>
  );
}
