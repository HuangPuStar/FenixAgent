import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { ArrowLeft, BookOpen, FileCode, FileText, Pencil, Search, Wand2 } from "lucide-react";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentApi } from "@/src/api/agents";
import { envApi } from "@/src/api/environments";
import { modelApi } from "@/src/api/models";
import { unwrap } from "@/src/api/request";
import { NS } from "../../../i18n";
import { dispatchConfigChange } from "../../../lib/config-events";
import type { GenerationFormData } from "../components/AgentGenerationForm";
import { AgentGenerationForm } from "../components/AgentGenerationForm";

const assetBase = import.meta.env.BASE_URL;

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

/** Agent 模板 */
interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  skills: string[];
}

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
  const [generationResult, setGenerationResult] = useState<GenerationFormData | null>(null);

  // 加载模板列表
  const { data: templatesData } = useRequest(() => unwrap(agentApi.templates()), {
    onError: (err) => {
      console.error("[agent-home] Failed to load templates:", err);
    },
  });
  const templates = templatesData?.templates ?? [];

  // AI 生成
  const { run: runGenerate } = useRequest(
    async (prompt: string) => {
      const response = await fetch("/web/agent-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ prompt }),
      });
      const json = (await response.json()) as {
        success: boolean;
        data?: GenerationFormData;
        error?: { message: string };
      };
      if (!json.success || !json.data) {
        throw new Error(json.error?.message ?? t("generationFailed"));
      }
      return json.data;
    },
    {
      manual: true,
      onSuccess: (data) => {
        setGenerationResult(data);
        setPhase("form");
      },
      onError: (err) => {
        console.error("[agent-home] Generation request failed:", err);
        toast.error(t("generationFailed"));
        setPhase("idle");
      },
    },
  );

  /** 创建 agent 配置 → 创建 environment → 跳转聊天页 */
  const { run: runCreateAndNavigate, loading: creating } = useRequest(
    async (data: GenerationFormData) => {
      // 0. 获取第一个可用模型，没有则报错
      const modelData = await unwrap(modelApi.get());
      const available = modelData.available;
      const firstModelId = Array.isArray(available) && available.length > 0 ? available[0].id : undefined;
      if (!firstModelId) {
        toast.error(t("noModel"));
        return;
      }

      // 1. 创建 agent 配置（已存在也继续）
      let agentConfigId: string | undefined;
      try {
        const agentRes = await unwrap(
          agentApi.create(data.name, {
            prompt: data.systemPrompt,
            skillIds: data.skills.map((s) => s.id),
            modelId: firstModelId,
          }),
        );
        agentConfigId = agentRes.id;
      } catch (err) {
        // ALREADY_EXISTS 不是错误，继续流程
        if ((err as { code?: string }).code !== "ALREADY_EXISTS") throw err;
      }

      // 2. 已存在时 create 不返回 id，需要查一次
      if (!agentConfigId) {
        const detail = await unwrap(agentApi.get(data.name));
        agentConfigId = detail?.id;
      }
      if (!agentConfigId) {
        toast.error(t("createFailed"));
        return;
      }

      // 刷新左侧智能体列表
      dispatchConfigChange("agents");

      // 3. 查找是否已有绑定该 agentConfigId 的 environment
      const envList = await unwrap(envApi.list());
      const existingEnv = (Array.isArray(envList) ? envList : []).find((e) => e.agentConfigId === agentConfigId);
      if (existingEnv) {
        void navigate({ to: "/agent/chat/$agentId", params: { agentId: existingEnv.id } });
        return;
      }

      // 4. 没有则创建新 environment（autoStart: true 自动启动实例）
      const newEnv = await unwrap(
        envApi.create({
          name: `env-${agentConfigId.slice(0, 8)}`,
          agentConfigId,
          autoStart: true,
        }),
      );
      const envId = newEnv?.id;
      if (!envId) {
        toast.error(t("createFailed"));
        return;
      }

      // 5. 跳转聊天页
      void navigate({ to: "/agent/chat/$agentId", params: { agentId: envId } });
    },
    {
      manual: true,
      onError: (err) => {
        console.error("[agent-home] Create and navigate failed:", err);
        toast.error(t("createFailed"));
      },
    },
  );

  // 模板先进入表单确认，保存后再创建
  const handleTemplateClick = (template: AgentTemplate) => {
    setInputValue(template.description || template.name);
    setGenerationResult({
      name: template.name,
      systemPrompt: template.prompt,
      skills: template.skills.map((skillId) => ({
        id: skillId,
        name: skillId,
        description: "",
      })),
    });
    setPhase("form");
  };

  // 返回 idle 状态
  const handleReset = () => {
    setPhase("idle");
    setGenerationResult(null);
  };

  const titleText = t(titleKey);

  return (
    <div className="agent-home-page relative flex flex-1 flex-col items-center overflow-auto">
      <div className="agent-home-bg" />
      <div className="agent-home-container">
        <div className="agent-home-header">
          <div className="agent-home-brand-icon">
            <img
              className="fenix-sidebar-logo-mark"
              src={`${assetBase}brand/fenix-agent-logo-mark.png`}
              alt=""
              aria-hidden="true"
            />
          </div>
          <h1>{renderAgentTitle(titleText)}</h1>
          {phase !== "form" && <p>{t("subtitle")}</p>}
        </div>

        <div className="agent-home-dialog">
          {phase === "idle" ? (
            <>
              <div className="agent-home-greeting">
                <Trans
                  i18nKey="greeting"
                  ns={NS.AGENT_HOME}
                  defaults="<strong>你好，</strong>告诉我你想创建一个怎样的智能体。描述它做什么、为谁服务，我会帮你生成配置。"
                  components={{ strong: <strong /> }}
                />
              </div>
              <div className="agent-home-input-wrap">
                <textarea
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      e.preventDefault();
                      const prompt = inputValue.trim();
                      if (!prompt) return;
                      setPhase("generating");
                      runGenerate(prompt);
                    }
                  }}
                  rows={2}
                  placeholder={t("inputPlaceholder")}
                />
                <button
                  type="button"
                  onClick={() => {
                    const prompt = inputValue.trim();
                    if (!prompt) return;
                    setPhase("generating");
                    runGenerate(prompt);
                  }}
                  className="agent-home-polish-btn"
                >
                  <Wand2 className="h-4 w-4" />
                  {t("oneClickCreate", { defaultValue: "一键创建" })}
                </button>
              </div>
            </>
          ) : (
            <div className="agent-home-submitted">
              <span>{inputValue}</span>
              <button type="button" onClick={handleReset}>
                {t("editInput")}
              </button>
            </div>
          )}
        </div>

        {phase === "generating" && (
          <div className="agent-home-loading">
            <div className="agent-home-spinner" />
            <div className="text-[14px] font-semibold text-[#0c1a3a]">{t("loadingTitle")}</div>
            <div className="text-[12px] text-[#8a96b0]">{t("loadingSubtitle")}</div>
          </div>
        )}

        {phase === "form" && generationResult && (
          <div className="agent-home-form">
            <div className="agent-home-form-header">
              <button type="button" className="agent-home-back-btn" onClick={handleReset}>
                <ArrowLeft className="h-4 w-4" />
                {t("back", { defaultValue: "返回" })}
              </button>
            </div>
            <AgentGenerationForm
              initialData={generationResult}
              onCreate={async (data) => {
                runCreateAndNavigate(data);
              }}
              loading={creating}
            />
          </div>
        )}

        {phase === "idle" && (
          <>
            <div className="agent-home-template-label">{t("orTemplate")}</div>
            <div className="agent-home-template-pills">
              {templates.map((template, index) => {
                const color = TEMPLATE_COLORS[index % TEMPLATE_COLORS.length];
                const Icon = TEMPLATE_ICONS[index % TEMPLATE_ICONS.length];

                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => handleTemplateClick(template)}
                    className="agent-home-template-pill"
                    style={
                      {
                        "--pill-accent": color.from,
                        "--pill-accent-end": color.to,
                        "--pill-glow": color.shadow,
                      } as CSSProperties
                    }
                  >
                    <span className="pill-icon">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="pill-copy">
                      <span className="pill-title">{template.name}</span>
                      <span className="pill-desc">{template.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <style>{`
        .agent-home-page {
          background: #f5f7fb;
          color: #0c1a3a;
        }
        .agent-home-bg {
          position: fixed;
          inset: 0;
          pointer-events: none;
          background:
            radial-gradient(500px circle at 25% 20%, rgba(15,107,255,0.06), transparent 60%),
            radial-gradient(400px circle at 75% 80%, rgba(107,230,255,0.05), transparent 60%);
        }
        .agent-home-container {
          position: relative;
          z-index: 1;
          display: flex;
          min-height: calc(100vh - 56px);
          width: min(100%, 1080px);
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 24px;
        }
        .agent-home-header {
          margin-bottom: 38px;
          text-align: center;
        }
        .agent-home-brand-icon {
          display: flex;
          width: 56px;
          height: 56px;
          margin: 0 auto 16px;
          align-items: center;
          justify-content: center;
          border-radius: 16px;
          background: linear-gradient(135deg, #0f6bff, #6be6ff);
          box-shadow: 0 4px 20px rgba(15,107,255,0.25);
        }
        .agent-home-brand-icon img {
          width: 30px;
          height: 30px;
          object-fit: contain;
        }
        .agent-home-header h1 {
          margin: 0 0 8px;
          font-size: 28px;
          font-weight: 800;
          letter-spacing: 0.02em;
          line-height: 1.25;
          color: #0c1a3a;
        }
        .agent-home-header h1 em {
          font-style: normal;
          background: linear-gradient(135deg, #0f6bff, #32b1ff, #6be6ff);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .agent-home-header p {
          max-width: 480px;
          margin: 0 auto;
          color: #5a6785;
          font-size: 15px;
        }
        .agent-home-dialog,
        .agent-home-loading,
        .agent-home-form {
          width: 100%;
          border: 1px solid rgba(12,26,58,0.1);
          border-radius: 16px;
          background: #fff;
          box-shadow: 0 4px 16px rgba(12,26,58,0.08);
        }
        .agent-home-dialog {
          max-width: 760px;
          margin-bottom: 24px;
          overflow: hidden;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .agent-home-dialog:focus-within {
          border-color: #0f6bff;
          box-shadow: 0 4px 24px rgba(15,107,255,0.12), 0 4px 16px rgba(12,26,58,0.08);
        }
        .agent-home-greeting {
          padding: 24px 28px 0;
          color: #5a6785;
          font-size: 14px;
          line-height: 1.7;
        }
        .agent-home-greeting strong {
          color: #0c1a3a;
          font-weight: 700;
        }
        .agent-home-input-wrap {
          display: flex;
          align-items: flex-end;
          gap: 12px;
          padding: 16px 20px 20px;
        }
        .agent-home-input-wrap textarea {
          min-height: 48px;
          max-height: 160px;
          flex: 1;
          resize: none;
          border: 0;
          outline: 0;
          background: transparent;
          color: #0c1a3a;
          font: inherit;
          font-size: 15px;
          line-height: 1.6;
        }
        .agent-home-input-wrap textarea::placeholder {
          color: #8a96b0;
        }
        .agent-home-polish-btn {
          display: inline-flex;
          flex-shrink: 0;
          align-items: center;
          gap: 6px;
          border: 0;
          border-radius: 10px;
          background: linear-gradient(135deg, #0f6bff, #32b1ff);
          color: #fff;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          padding: 10px 18px;
          transition: transform 0.2s, box-shadow 0.2s;
          white-space: nowrap;
        }
        .agent-home-polish-btn:hover {
          box-shadow: 0 4px 14px rgba(15,107,255,0.3);
          transform: translateY(-1px);
        }
        .agent-home-submitted {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 18px 22px;
        }
        .agent-home-submitted span {
          flex: 1;
          color: #0c1a3a;
          font-size: 14px;
          line-height: 1.6;
        }
        .agent-home-submitted button {
          border: 0;
          background: transparent;
          color: #0f6bff;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
        }
        .agent-home-loading {
          display: flex;
          max-width: 600px;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          margin-bottom: 24px;
          padding: 24px;
        }
        .agent-home-spinner,
        .pill-spinner {
          border-radius: 999px;
          border: 3px solid rgba(15,107,255,0.14);
          border-top-color: #0f6bff;
          animation: agent-spin 0.8s linear infinite;
        }
        .agent-home-spinner {
          width: 32px;
          height: 32px;
        }
        .pill-spinner {
          width: 16px;
          height: 16px;
        }
        .agent-home-form {
          max-width: 760px;
          padding: 28px;
        }
        .agent-home-form-header {
          display: flex;
          align-items: center;
          margin-bottom: 18px;
        }
        .agent-home-back-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border: 0;
          border-radius: 9px;
          background: rgba(15,107,255,0.08);
          color: #0f6bff;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          padding: 8px 12px;
          transition: background 0.2s, transform 0.2s;
        }
        .agent-home-back-btn:hover {
          background: rgba(15,107,255,0.12);
          transform: translateY(-1px);
        }
        .agent-home-template-label {
          margin-bottom: 16px;
          color: #8a96b0;
          font-size: 12px;
          letter-spacing: 0.04em;
          text-align: center;
        }
        .agent-home-template-pills {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          width: min(100%, 900px);
        }
        .agent-home-template-pill {
          position: relative;
          display: flex;
          width: 100%;
          align-items: center;
          gap: 10px;
          overflow: hidden;
          border: 1px solid rgba(12,26,58,0.1);
          border-radius: 14px;
          background: #fff;
          box-shadow: 0 1px 3px rgba(12,26,58,0.04);
          color: #5a6785;
          cursor: pointer;
          padding: 12px 16px;
          text-align: left;
          transition: border-color 0.25s, box-shadow 0.25s, transform 0.25s;
        }
        .agent-home-template-pill::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 2px;
          background: linear-gradient(90deg, var(--pill-accent), var(--pill-accent-end));
          opacity: 0;
          transition: opacity 0.25s;
        }
        .agent-home-template-pill:hover {
          border-color: var(--pill-accent);
          box-shadow: 0 4px 16px rgba(15,107,255,0.12), 0 1px 3px rgba(12,26,58,0.06);
          color: #0c1a3a;
          transform: translateY(-2px);
        }
        .agent-home-template-pill:hover::before {
          opacity: 1;
        }
        .agent-home-template-pill:disabled {
          cursor: not-allowed;
          opacity: 0.64;
          transform: none;
        }
        .pill-icon {
          position: relative;
          z-index: 1;
          display: flex;
          width: 32px;
          height: 32px;
          flex-shrink: 0;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          background: color-mix(in srgb, var(--pill-accent) 10%, white);
          color: var(--pill-accent);
          transition: background 0.25s, color 0.25s, box-shadow 0.25s;
        }
        .agent-home-template-pill:hover .pill-icon {
          background: linear-gradient(135deg, var(--pill-accent), var(--pill-accent-end));
          box-shadow: 0 2px 8px var(--pill-glow);
          color: #fff;
        }
        .pill-copy {
          position: relative;
          z-index: 1;
          display: flex;
          min-width: 0;
          flex-direction: column;
        }
        .pill-title {
          color: #0c1a3a;
          font-size: 13px;
          font-weight: 700;
        }
        .pill-desc {
          overflow: hidden;
          color: #8a96b0;
          font-size: 11px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        @keyframes agent-spin {
          to { transform: rotate(360deg); }
        }
        @media (max-width: 760px) {
          .agent-home-container {
            justify-content: flex-start;
            padding: 32px 16px;
          }
          .agent-home-header h1 {
            font-size: 25px;
          }
          .agent-home-input-wrap,
          .agent-home-submitted {
            flex-direction: column;
            align-items: stretch;
          }
          .agent-home-polish-btn {
            justify-content: center;
          }
          .agent-home-template-pill {
            grid-column: auto;
          }
          .agent-home-template-pills {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}

function renderAgentTitle(title: string) {
  const marker = "Agent";
  const index = title.indexOf(marker);
  if (index < 0) return title;

  return (
    <>
      {title.slice(0, index)}
      <em>{marker}</em>
      {title.slice(index + marker.length)}
    </>
  );
}
