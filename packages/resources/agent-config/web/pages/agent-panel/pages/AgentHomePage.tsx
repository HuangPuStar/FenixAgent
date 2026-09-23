// pages/agent-panel/pages/AgentHomePage.tsx
// agent-panel 的「创建智能体」首页（`/agent/home`）：一句话智能生成 + 模板一键创建。
//
// §1.6 T11e-3c 随「宿主剩余页面归位」迁入本包（原寄居 `apps/web/src/pages/agent-panel/pages/`）。
// 它的值依赖全在包侧：`agentApi`（本包 `web/api`）、`envApi`（agent-runtime，经唯一放行的深路径）、
// `modelApi`（model-management 包根）、表单元件 `AgentGenerationForm`；平铺在宿主只能靠 vite / tsconfig 的
// `@/src/...` 桥接别名解析。`agentHome` 字典同批归位（见 `web/i18n/namespace.ts`），创建后进入实例的
// `resolveCreatedAgentChatTarget` 落在 `web/lib/agent-create-navigation.ts`——宿主壳也消费它。
//
// §4.8 拆分（2026-09-23）：本文件只留**页面自己的职责**——阶段状态、三个请求的接线与渲染。
// 内联样式表（原先占了全页约一半行数）移到 `agent-home-styles.ts`，模板卡片陈列与其色系/图标登记移到
// `agent-home-template-pills.tsx`，「创建并解析实例目标」的编排移到 `agent-home-creation.ts`：
// 页面保留用户可见决策（提示文案、跳哪条路由），模块只回判别式结果。
import { unwrap } from "@fenix/web-runtime/api/request";
import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { ArrowLeft, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentApi } from "../../../api/agents";
import { AGENT_HOME_NS } from "../../../i18n/namespace";
import type { GenerationFormData } from "../components/AgentGenerationForm";
import { AgentGenerationForm } from "../components/AgentGenerationForm";
import { createAgentAndResolveChatTarget } from "./agent-home-creation";
import { AGENT_HOME_STYLES } from "./agent-home-styles";
import type { AgentTemplate } from "./agent-home-template-pills";
import { AgentHomeTemplatePills } from "./agent-home-template-pills";

const assetBase = import.meta.env.BASE_URL;

type PagePhase = "idle" | "generating" | "form";

/** 判断输入是否包含可用于生成 Agent 的有效描述。 */
export function hasAgentGenerationPrompt(value: string): boolean {
  return value.trim().length > 0;
}

/** Agent 首页：AI 智能生成 + 模板一键创建 */
export function AgentHomePage() {
  const { t } = useTranslation(AGENT_HOME_NS);
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
      // 模板区失败后只剩「或从模板快速开始」标签 + 空容器，与「确实没有模板」在界面上同形；
      // 该分支没有可重试的失败区，故补一次可见提示，避免把加载失败读成产品没有模板。
      toast.error(t("templatesFailed"));
    },
  });
  const templates = templatesData?.templates ?? [];

  // AI 生成
  const { run: runGenerate } = useRequest(
    // 请求落在本包域模块 `agentApi.generate`（组件不写 fetch、不拼后端 URL）。失败由 `unwrap` 归一为
    // ApiError，页面只消费成功数据与错误分类。
    async (prompt: string) => unwrap(agentApi.generate(prompt)),
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
      const outcome = await createAgentAndResolveChatTarget(data);
      // 两句提示分属两种「走到这里但没得跳」的形态，见 `AgentCreationOutcome` 的说明。
      if (outcome.status === "no-model") {
        toast.error(t("noModel"));
        return;
      }
      if (outcome.status === "no-config") {
        toast.error(t("createFailed"));
        return;
      }

      await navigate({
        to: "/agent/chat/$agentId/$sessionId",
        params: { agentId: outcome.environmentId, sessionId: outcome.instanceUid },
      });
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
  const canGenerate = hasAgentGenerationPrompt(inputValue);

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
                  ns={AGENT_HOME_NS}
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
                  disabled={!canGenerate}
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
            <div className="text-sm font-semibold text-slate-900">{t("loadingTitle")}</div>
            <div className="text-xs text-slate-400">{t("loadingSubtitle")}</div>
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
            <AgentHomeTemplatePills templates={templates} onSelect={handleTemplateClick} />
          </>
        )}
      </div>

      <style>{AGENT_HOME_STYLES}</style>
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
