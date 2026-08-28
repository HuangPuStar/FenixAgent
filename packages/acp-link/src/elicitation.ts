// packages/acp-link/src/elicitation.ts
// ACP elicitation/create（AskUserQuestion，UNSTABLE）支持：
// agent → client 的 form 模式 JSON Schema 提问。SDK 只在 client 实现
// unstable_createElicitation 时注册 handler（否则返回 -32601 Method not found）。
//
// 本模块把 requestedSchema（JSON Schema form）解析为 InteractiveQuestionPayload
// 的 questions 形态（与 claude-acp-adapter 的 AskUserQuestion 拦截输出一致），
// 供 local（server.ts）与 remote（spawnAcpAgent）两条 spawn 路径复用
// （createElicitationHandler 统一 handle/resolve/cancelAll）。
//
// 答案组装：peri 侧按 content[q_id] = 选项 label 解析（transport_broker.rs
// map_elicitation_answer：String → text 注入 LLM），q_id 为 schema properties
// 的键（如 ask_user_question_0）。前端回传 answers 数组（按问题顺序）后，
// 由 handler 按 propertyKeys[i] ↔ questions[i] 对应关系组装。

import type { InteractiveQuestionPayload } from "./types.js";

/** 等待前端应答的超时（与 claude-adapter 的 interactive_question 60s 对齐） */
export const ELICITATION_TIMEOUT_MS = 60_000;

/** 解析 form 模式 requestedSchema → interactive_question 帧的 questions 数组 */
export function parseElicitationSchema(schema: unknown): InteractiveQuestionPayload["questions"] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties as Record<string, Record<string, unknown>>)
    .map(([, prop]) => {
      const p = prop as Record<string, unknown>;
      // 单选 schema：oneOf 枚举；多选：type: array + items.anyOf（items 为对象）或 items 数组
      let optionsRaw: unknown[] = [];
      if (Array.isArray(p.oneOf)) {
        optionsRaw = p.oneOf;
      } else if (Array.isArray(p.items)) {
        optionsRaw = p.items;
      } else if (p.items && typeof p.items === "object" && Array.isArray((p.items as Record<string, unknown>).anyOf)) {
        optionsRaw = (p.items as Record<string, unknown>).anyOf as unknown[];
      }
      const options = (optionsRaw as Record<string, unknown>[])
        .map((o) => ({
          label:
            typeof o.const === "string" && o.const.length > 0 ? o.const : typeof o.title === "string" ? o.title : "",
          description: typeof o.description === "string" ? o.description : null,
        }))
        .filter((o) => o.label.length > 0);
      return {
        // peri 构造 schema 时 title = header、description = question（transport_broker）
        question: typeof p.description === "string" ? p.description : "",
        header: typeof p.title === "string" && p.title.length > 0 ? p.title : null,
        options,
      };
    })
    .filter((q) => q.question.length > 0);
}

/** 待决提问请求（handle 创建，resolve/cancelAll 消费） */
interface PendingElicitation {
  resolve: (content: Record<string, unknown>) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** schema properties 键（q_id），与 interactive_question 帧 questions 顺序对应 */
  propertyKeys: string[];
}

/** elicitation 处理器：handle 创建提问、resolve 消费答案、cancelAll 批量取消 */
export interface ElicitationHandler {
  /** unstable_createElicitation 工厂实现（SDK 只在此注册时发送 elicitation/create） */
  handle: (params: Record<string, unknown>) => Promise<{ action: "accept"; content: Record<string, unknown> }>;
  /** 消费 control_response 帧答案（匹配 request_id），返回 false 表示未知 requestId */
  resolve: (requestId: string, extra: Record<string, unknown> | undefined) => boolean;
  /** 取消全部待决提问（连接断开/批量取消），以空答案 resolve（agent 按空答案继续） */
  cancelAll: () => void;
}

/**
 * 创建 elicitation 处理器（local server.ts 与 remote spawnAcpAgent 两条 spawn
 * 路径复用，避免重复实现）：
 * - handle：解析 requestedSchema → send interactive_question 帧 → 等待答案
 *   （ELICITATION_TIMEOUT_MS 超时自动以空答案 resolve，与 claude-adapter 行为一致）
 * - resolve：control_response 帧到达时组装 content[q_id]=label 并 resolve
 */
export function createElicitationHandler(send: (payload: InteractiveQuestionPayload) => void): ElicitationHandler {
  const pending = new Map<string, PendingElicitation>();

  return {
    async handle(params: Record<string, unknown>) {
      // ACP spec（UNSTABLE）：params = { mode: "form", sessionId, message, requestedSchema }
      const sessionId = (params?.sessionId as string) ?? "";
      const questions = parseElicitationSchema(params?.requestedSchema);
      const propertyKeys = extractPropertyKeys(params?.requestedSchema);
      const questionId = `iqa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const answer = await new Promise<Record<string, unknown>>((resolve) => {
        const timeout = setTimeout(() => {
          pending.delete(questionId);
          // 前端未应答：空答案（与 claude-adapter 60s 行为一致，agent 按空答案继续）
          resolve({});
        }, ELICITATION_TIMEOUT_MS);
        pending.set(questionId, { resolve, timeout, propertyKeys });
        send({
          sessionId,
          questionId,
          toolId: "elicitation",
          toolName: "AskUserQuestion",
          questions,
          description: typeof params?.message === "string" ? params.message : "Please answer the following questions",
        });
      });

      return { action: "accept" as const, content: answer };
    },

    resolve(requestId, extra) {
      const item = pending.get(requestId);
      if (!item) return false;
      clearTimeout(item.timeout);
      pending.delete(requestId);
      item.resolve(buildElicitationContent(extra, item.propertyKeys));
      return true;
    },

    cancelAll() {
      for (const [, item] of pending) {
        clearTimeout(item.timeout);
        item.resolve({});
      }
      pending.clear();
    },
  };
}

/** 提取 schema properties 的键（q_id），与 questions 数组顺序一一对应 */
export function extractPropertyKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.keys(properties as Record<string, unknown>);
}

/** 从 control_response 帧的 extra 解析用户答案，组装为 elicitation content（q_id → label） */
export function buildElicitationContent(
  extra: Record<string, unknown> | undefined,
  propertyKeys: string[],
): Record<string, unknown> {
  const answers = extra?.answers;
  if (Array.isArray(answers)) {
    // 多问题合并答案：answers[i] = 第 i 个问题的选中 label，按 propertyKeys（q_id）顺序
    // 组装（与 parseElicitationSchema / extractPropertyKeys 同源顺序）；未选的 q_id 不填
    const content: Record<string, unknown> = {};
    for (let i = 0; i < propertyKeys.length; i++) {
      const label = answers[i];
      if (typeof label === "string" && label.length > 0) {
        content[propertyKeys[i] as string] = label;
      }
    }
    return content;
  }
  const outcome = extra?.outcome as Record<string, unknown> | undefined;
  if (outcome && typeof outcome.optionId === "string" && outcome.optionId.length > 0) {
    // 单问题兼容（历史形态）：第一个 propertyKey 即唯一问题
    return propertyKeys.length > 0 ? { [propertyKeys[0] as string]: outcome.optionId } : {};
  }
  return {};
}
