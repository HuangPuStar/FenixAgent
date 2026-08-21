import { describe, expect, test } from "bun:test";
import {
  buildElicitationContent,
  createElicitationHandler,
  extractPropertyKeys,
  parseElicitationSchema,
} from "../elicitation.js";

const twoQuestionSchema = {
  type: "object",
  properties: {
    first: {
      title: "第一题",
      description: "请选择第一个答案",
      oneOf: [{ const: "甲", description: "甲的说明" }],
    },
    second: {
      description: "请选择第二个答案",
      items: { anyOf: [{ title: "乙", description: "乙的说明" }] },
    },
  },
};

function createMemorySender() {
  const payloads: Array<{
    sessionId: string;
    questionId: string;
    toolId: string;
    toolName: string;
    questions: ReturnType<typeof parseElicitationSchema>;
    description: string;
  }> = [];
  return { payloads, send: (payload: (typeof payloads)[number]) => payloads.push(payload) };
}

describe("elicitation 第四十九轮真实协议分支", () => {
  // 非对象 schema 属于协议错误输入，解析器应安全地忽略。
  test("拒绝原始值 schema", () => {
    expect(parseElicitationSchema("schema")).toEqual([]);
  });

  // 数组不是 form schema，不能被误解为 properties 容器。
  test("拒绝数组 schema", () => {
    expect(parseElicitationSchema([])).toEqual([]);
  });

  // properties 缺失时没有可发送给前端的问题。
  test("缺少 properties 时不产生问题", () => {
    expect(parseElicitationSchema({ type: "object" })).toEqual([]);
  });

  // oneOf 的 const 是前端回传时应使用的稳定选项 label。
  test("解析 oneOf 的 const 与说明", () => {
    expect(
      parseElicitationSchema({
        properties: { choice: { description: "选哪个", oneOf: [{ const: "保留", description: "不变" }] } },
      }),
    ).toEqual([{ question: "选哪个", header: null, options: [{ label: "保留", description: "不变" }] }]);
  });

  // const 不可用时，title 可作为前端可展示且可回传的 label。
  test("以 title 回退为选项 label", () => {
    expect(
      parseElicitationSchema({ properties: { choice: { description: "选哪个", oneOf: [{ title: "回退" }] } } }),
    ).toEqual([{ question: "选哪个", header: null, options: [{ label: "回退", description: null }] }]);
  });

  // items 数组是多选 schema 的另一种 ACP 表达。
  test("解析 items 数组中的选项", () => {
    expect(
      parseElicitationSchema({
        properties: { choices: { description: "可多选", items: [{ const: "一" }, { const: "二" }] } },
      }),
    ).toEqual([
      {
        question: "可多选",
        header: null,
        options: [
          { label: "一", description: null },
          { label: "二", description: null },
        ],
      },
    ]);
  });

  // items.anyOf 是 transport 发送多选项时支持的对象形态。
  test("解析 items.anyOf 中的选项", () => {
    expect(parseElicitationSchema(twoQuestionSchema)[1]?.options).toEqual([{ label: "乙", description: "乙的说明" }]);
  });

  // 空 label 不能成为可点击选项，避免把无效答案送回 agent。
  test("过滤空 label 的选项", () => {
    expect(
      parseElicitationSchema({
        properties: { choice: { description: "选", oneOf: [{ const: "" }, { const: "有效" }] } },
      }),
    ).toEqual([{ question: "选", header: null, options: [{ label: "有效", description: null }] }]);
  });

  // 没有问题正文的属性不会生成不可理解的 interactive_question。
  test("过滤没有 description 的属性", () => {
    expect(parseElicitationSchema({ properties: { choice: { title: "标题", oneOf: [{ const: "甲" }] } } })).toEqual([]);
  });

  // Object.keys 顺序必须与问题顺序一致，才能将 answers 映射回 q_id。
  test("按 schema 属性顺序提取 q_id", () => {
    expect(extractPropertyKeys(twoQuestionSchema)).toEqual(["first", "second"]);
  });

  // 非法 properties 不能在提取 q_id 时抛出错误。
  test("非法 properties 返回空 q_id", () => {
    expect(extractPropertyKeys({ properties: null })).toEqual([]);
  });

  // answers 数组是前端多题应答，按下标映射回各自 q_id。
  test("将多题 answers 映射为 content", () => {
    expect(buildElicitationContent({ answers: ["甲", "乙"] }, ["first", "second"])).toEqual({
      first: "甲",
      second: "乙",
    });
  });

  // 数组应答中的空值和非字符串不是有效用户选择。
  test("忽略无效 answers 项", () => {
    expect(buildElicitationContent({ answers: ["甲", 3, ""] }, ["first", "second", "third"])).toEqual({ first: "甲" });
  });

  // 旧版单题前端以 outcome.optionId 表示选项，仍需兼容。
  test("兼容单题 outcome.optionId", () => {
    expect(buildElicitationContent({ outcome: { optionId: "甲" } }, ["first"])).toEqual({ first: "甲" });
  });

  // 没有 q_id 时不能把历史响应写入任意键。
  test("没有 q_id 时丢弃历史响应", () => {
    expect(buildElicitationContent({ outcome: { optionId: "甲" } }, [])).toEqual({});
  });

  // handle 应发送完整的内存协议帧，并接受用户的多题应答。
  test("发送协议帧并解析用户 answers", async () => {
    const memory = createMemorySender();
    const handler = createElicitationHandler(memory.send);
    const result = handler.handle({ sessionId: "session-1", message: "请回答", requestedSchema: twoQuestionSchema });
    const payload = memory.payloads[0];
    expect(payload).toMatchObject({
      sessionId: "session-1",
      toolId: "elicitation",
      toolName: "AskUserQuestion",
      description: "请回答",
    });
    expect(payload?.questions).toHaveLength(2);
    expect(handler.resolve(payload?.questionId ?? "", { answers: ["甲", "乙"] })).toBe(true);
    expect(await result).toEqual({ action: "accept", content: { first: "甲", second: "乙" } });
  });

  // 缺少 message 时应使用协议默认说明，不向前端发送 undefined。
  test("使用默认说明发送问题", async () => {
    const memory = createMemorySender();
    const handler = createElicitationHandler(memory.send);
    const result = handler.handle({ requestedSchema: twoQuestionSchema });
    expect(memory.payloads[0]?.description).toBe("Please answer the following questions");
    handler.cancelAll();
    await expect(result).resolves.toEqual({ action: "accept", content: {} });
  });

  // 未知 requestId 是迟到或错误响应，必须被拒绝且不影响待决请求。
  test("拒绝未知 requestId 并保留待决请求", async () => {
    const memory = createMemorySender();
    const handler = createElicitationHandler(memory.send);
    const result = handler.handle({ requestedSchema: twoQuestionSchema });
    expect(handler.resolve("unknown", { answers: ["错误"] })).toBe(false);
    expect(handler.resolve(memory.payloads[0]?.questionId ?? "", { answers: ["甲"] })).toBe(true);
    expect(await result).toEqual({ action: "accept", content: { first: "甲" } });
  });

  // cancelAll 模拟连接断开，所有待决 agent 请求都应以空答案继续。
  test("取消全部待决请求", async () => {
    const memory = createMemorySender();
    const handler = createElicitationHandler(memory.send);
    const first = handler.handle({ requestedSchema: twoQuestionSchema });
    const second = handler.handle({ sessionId: "other", requestedSchema: twoQuestionSchema });
    handler.cancelAll();
    await expect(first).resolves.toEqual({ action: "accept", content: {} });
    await expect(second).resolves.toEqual({ action: "accept", content: {} });
  });

  // 两个并发请求必须依据各自 questionId 隔离，不能串写用户答案。
  test("隔离并发请求的答案", async () => {
    const memory = createMemorySender();
    const handler = createElicitationHandler(memory.send);
    const first = handler.handle({ requestedSchema: twoQuestionSchema });
    const second = handler.handle({ requestedSchema: twoQuestionSchema });
    const firstId = memory.payloads[0]?.questionId ?? "";
    const secondId = memory.payloads[1]?.questionId ?? "";
    expect(handler.resolve(secondId, { answers: ["乙"] })).toBe(true);
    expect(await second).toEqual({ action: "accept", content: { first: "乙" } });
    expect(handler.resolve(firstId, { answers: ["甲"] })).toBe(true);
    expect(await first).toEqual({ action: "accept", content: { first: "甲" } });
  });

  // 超时回调必须删除待决项并以空答案继续，后续响应视为未知。
  test("超时后以空答案完成并拒绝迟到响应", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let onTimeout: (() => void) | undefined;
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (callback: () => void) => {
        onTimeout = callback;
        return 0;
      },
    });
    try {
      const memory = createMemorySender();
      const handler = createElicitationHandler(memory.send);
      const result = handler.handle({ requestedSchema: twoQuestionSchema });
      onTimeout?.();
      await expect(result).resolves.toEqual({ action: "accept", content: {} });
      expect(handler.resolve(memory.payloads[0]?.questionId ?? "", { answers: ["甲"] })).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: originalSetTimeout });
    }
  });
});
