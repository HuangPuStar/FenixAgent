// pages/agent-panel/pages/agent-home-creation.ts
// 首页提交后的「创建并进入实例」编排：取可用模型 → 创建/复用 agent 配置 → 解析聊天跳转目标。
//
// §4.8 拆分（2026-09-23）：这段流程原先内联在 `AgentHomePage` 的 `useRequest` 里，与页面的阶段状态、
// 渲染混在同一文件。它与 DOM 无关，只依赖三个域模块（`modelApi` / `agentApi` / `envApi`）与
// `resolveCreatedAgentChatTarget`，因此单独成模块；页面保留「拿到结果后 toast 什么、跳哪条路由」这层
// 用户可见决策（含错误分类与用户反馈），模块只负责把结果归一成判别式。
import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { modelApi } from "@fenix/model-management/web";
import { unwrap } from "@fenix/web-runtime/api/request";
import { dispatchConfigChange } from "@fenix/web-runtime/lib/config-events";
import { agentApi } from "../../../api/agents";
import { resolveCreatedAgentChatTarget } from "../../../lib/agent-create-navigation";
import type { GenerationFormData } from "../components/AgentGenerationForm";

/**
 * 创建流程的终态。
 *
 * 「没有可用模型」与「没拿到 agent 配置 id」在页面上是两句不同的提示（`noModel` / `createFailed`），
 * 用判别式而不是抛异常回到调用方：两者都不是**故障**（前者是产品状态、后者是已存在配置的兜底查询落空），
 * 抛错会被页面的 `onError` 一并读成「创建失败」，正是要避免的误报。
 */
export type AgentCreationOutcome =
  | { status: "created"; environmentId: string; instanceUid: string }
  | { status: "no-model" }
  | { status: "no-config" };

/** 创建 agent 配置 → 创建或复用 environment → 返回可导航的聊天页目标。 */
export async function createAgentAndResolveChatTarget(data: GenerationFormData): Promise<AgentCreationOutcome> {
  // 0. 获取第一个可用模型，没有则报错
  const modelData = await unwrap(modelApi.get());
  const available = modelData.available;
  const firstModelId = Array.isArray(available) && available.length > 0 ? available[0].id : undefined;
  if (!firstModelId) {
    return { status: "no-model" };
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
    return { status: "no-config" };
  }

  // 刷新左侧智能体列表
  dispatchConfigChange("agents");

  // 3. 创建或复用 environment，并显式进入实例后再导航。
  // environment 的 autoStart 是异步预热，不能作为实例已可用的确认信号。
  const target = await resolveCreatedAgentChatTarget(agentConfigId, {
    list: async () => {
      const environments = await unwrap(envApi.list());
      return Array.isArray(environments) ? environments : [];
    },
    create: async (body) => unwrap(envApi.create(body)),
    enter: async (environmentId) => unwrap(envApi.enter({ id: environmentId })),
  });

  return { status: "created", environmentId: target.environmentId, instanceUid: target.instanceUid };
}
