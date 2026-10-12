// chat-utils 的纯逻辑单测。
//
// 为什么值得单独测：详情面板的 chat 视图与 JSON 视图靠这一层做分支判定，判错一次用户看到的就是「明明是对话
// 却摊成 JSON」或「明明是 JSON 却被当成对话」。两族协议（OpenAI 的字符串 content + tool_calls、Anthropic 的
// 分片数组）在同一批函数里收敛，形状边界必须逐条钉住。

import { describe, expect, test } from "bun:test";

import {
  contentToText,
  extractMessages,
  extractParts,
  groupConsecutive,
  isChatPayload,
  isKnownRole,
  parseMaybeString,
} from "../lib/chat-utils";

const openAiMessages = [
  { role: "system", content: "你是运维助手" },
  { role: "user", content: "重启一下服务" },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", function: { name: "restart_service", arguments: '{"name":"api"}' } }],
  },
  { role: "tool", tool_call_id: "call_1", content: "已重启" },
];

const anthropicMessages = [
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先看看进程状态" },
      { type: "text", text: "我来检查" },
      { type: "tool_use", id: "toolu_1", name: "ps", input: { all: true } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "PID 1234 node" }],
  },
];

describe("parseMaybeString", () => {
  // 上游把 observation 的 IO 以 JSON 字符串下发，解析后形状判定才看得到对象。
  test("字符串化 JSON 解析成对象", () => {
    expect(parseMaybeString('{"messages":[{"role":"user","content":"hi"}]}')).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  // 非 JSON 字符串是合法输入（纯文本输出），必须原样返回而不是抛错或变成 undefined。
  test("非 JSON 字符串原样返回", () => {
    expect(parseMaybeString("hello")).toBe("hello");
  });

  // 非字符串值（对象、数字、null）不做任何处理，避免二次解析改变语义。
  test("非字符串值原样透传", () => {
    const value = { a: 1 };
    expect(parseMaybeString(value)).toBe(value);
    expect(parseMaybeString(42)).toBe(42);
    expect(parseMaybeString(null)).toBeNull();
  });
});

describe("isChatPayload / extractMessages", () => {
  // 最常见的 trace input 形状：{messages:[...]} 必须识别为对话。
  test("识别 {messages:[...]} 形状的 OpenAI 对话", () => {
    expect(isChatPayload({ messages: openAiMessages })).toBe(true);
  });

  // 裸消息数组同样是 chat 载荷（Anthropic 与部分 SDK 直接下发数组）。
  test("识别裸消息数组", () => {
    expect(isChatPayload(anthropicMessages)).toBe(true);
  });

  // 空数组没有任何消息特征，当成对话会渲染出空壳对话视图，必须判否。
  test("空数组与空 messages 不视为对话", () => {
    expect(isChatPayload([])).toBe(false);
    expect(isChatPayload({ messages: [] })).toBe(false);
  });

  // 非消息数组（如嵌入向量、分页结果）不能被误判成对话。
  test("元素不是消息的数组判否", () => {
    expect(isChatPayload([{ foo: 1 }, { bar: 2 }])).toBe(false);
    expect(isChatPayload({ messages: [1, 2, 3] })).toBe(false);
  });

  // 单个消息对象不是载荷（缺少外层数组），字符串与 null 同样判否。
  test("消息对象本身、字符串与 null 判否", () => {
    expect(isChatPayload({ role: "assistant", content: "hi" })).toBe(false);
    expect(isChatPayload("hello")).toBe(false);
    expect(isChatPayload(null)).toBe(false);
  });

  // OpenAI：content 为 null 且只带 tool_calls 的 assistant 轮次是合法消息，必须能取出。
  test("OpenAI 消息归一化保留 tool_calls 与 tool_call_id", () => {
    const messages = extractMessages({ messages: openAiMessages });
    expect(messages).toHaveLength(4);
    expect(messages?.[2].role).toBe("assistant");
    expect(messages?.[2].content).toBeNull();
    expect(messages?.[2].toolCalls).toEqual(openAiMessages[2].tool_calls);
    expect(messages?.[3].toolCallId).toBe("call_1");
  });

  // Anthropic 的工具结果由 role:user + tool_result 分片承载，要归一化成 tool 角色才能渲染成工具气泡。
  test("Anthropic 工具结果消息归一化为 tool 角色", () => {
    const messages = extractMessages(anthropicMessages);
    expect(messages?.[0].role).toBe("assistant");
    expect(messages?.[1].role).toBe("tool");
  });

  // 非 chat 载荷必须返回 null，调用方据此回退 JSON 视图。
  test("非 chat 载荷返回 null", () => {
    expect(extractMessages({ foo: "bar" })).toBeNull();
    expect(extractMessages("hello")).toBeNull();
  });

  // 归一化是无损的：raw 保留协议原文，界面要回看原始字段时不必重新解析。
  test("归一化保留原始消息对象", () => {
    const messages = extractMessages({ messages: openAiMessages });
    expect(messages?.[3].raw).toEqual(openAiMessages[3]);
  });
});

describe("extractParts", () => {
  // OpenAI 的字符串 content 摊平成单个 text 分片。
  test("字符串 content 转成一个 text 分片", () => {
    expect(extractParts("你好")).toEqual([{ type: "text", text: "你好" }]);
  });

  // 空 content 不产生分片，避免渲染出空文本块。
  test("空 content 不产生分片", () => {
    expect(extractParts("")).toEqual([]);
    expect(extractParts(null)).toEqual([]);
    expect(extractParts(undefined)).toEqual([]);
  });

  // OpenAI 的 tool_calls 挂在消息上，与 content 合并成同一条分片流。
  test("OpenAI tool_calls 合并为 tool_use 分片", () => {
    const parts = extractParts(null, openAiMessages[2].tool_calls);
    expect(parts).toEqual([{ type: "tool_use", name: "restart_service", input: '{"name":"api"}' }]);
  });

  // Anthropic 的分片数组逐类映射：思考、文本、工具调用、工具结果各得其所。
  test("Anthropic 分片数组映射为对应分片类型", () => {
    const parts = extractParts(anthropicMessages[0].content);
    expect(parts).toEqual([
      { type: "thinking", text: "先看看进程状态" },
      { type: "text", text: "我来检查" },
      { type: "tool_use", id: "toolu_1", name: "ps", input: { all: true } },
    ]);
  });

  // 工具结果分片要取 tool_use_id 配对并递归取正文，否则界面上无法把结果与调用对上。
  test("Anthropic tool_result 分片带 id 与正文", () => {
    const parts = extractParts(anthropicMessages[1].content);
    expect(parts).toEqual([{ type: "tool_result", id: "toolu_1", text: "PID 1234 node" }]);
  });

  // 图片与音频分片（多模态输入）不能丢：图片取 url，音频只留类型标记。
  test("图片与音频分片保留类型信息", () => {
    expect(extractParts([{ type: "image_url", image_url: { url: "https://x/y.png" } }])).toEqual([
      { type: "image", url: "https://x/y.png" },
    ]);
    expect(extractParts([{ type: "input_audio", input_audio: { data: "…" } }])).toEqual([{ type: "audio" }]);
  });

  // 未登记的分片类型不能静默丢弃：原样保留，界面才有机会展示。
  test("未知分片类型原样保留", () => {
    expect(extractParts([{ type: "citation", url: "https://x" }])).toEqual([
      { type: "unknown", raw: { type: "citation", url: "https://x" } },
    ]);
  });

  // 非数组、非字符串的 content（某些 SDK 直接塞对象）整体作为未知分片保留。
  test("对象 content 作为未知分片保留", () => {
    expect(extractParts({ answer: 42 })).toEqual([{ type: "unknown", raw: { answer: 42 } }]);
  });
});

describe("contentToText", () => {
  // 纯文本与分片文本是最常见的两种正文，必须直接可读。
  test("字符串与 text 分片取正文", () => {
    expect(contentToText("你好")).toBe("你好");
    expect(
      contentToText([
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n第二段");
  });

  // 多模态占位符（图片 / 音频）让纯文本摘要不至于把附件整段丢掉。
  test("图片与音频分片产出占位符", () => {
    expect(contentToText([{ type: "image_url", image_url: { url: "x" } }])).toBe("[image]");
    expect(contentToText([{ type: "input_audio" }])).toBe("[audio]");
  });

  // 思维链与工具调用/结果在文本摘要里要带标记，避免与助手正式回答混为一谈。
  test("思考与工具分片带标记输出", () => {
    expect(contentToText([{ type: "thinking", thinking: "想一想" }])).toBe("[thinking]\n想一想");
    expect(contentToText([{ type: "tool_use", name: "ps", input: { all: true } }])).toBe(
      '[tool_use: ps({"all":true})]',
    );
    expect(contentToText([{ type: "tool_result", content: "PID 1234" }])).toBe("[tool_result]\nPID 1234");
  });

  // 对象 content 序列化成缩进 JSON，便于预览里阅读结构。
  test("对象 content 序列化为缩进 JSON", () => {
    expect(contentToText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  // 空值统一返回空串：调用方用「空串即无内容」判断占位符，不能拿到 "null" 这类文本。
  test("空值返回空串", () => {
    expect(contentToText(null)).toBe("");
    expect(contentToText(undefined)).toBe("");
  });
});

describe("groupConsecutive", () => {
  // 连续同角色消息合并成一组：一排工具结果各占一个气泡会把对话淹掉。
  test("合并连续同角色消息", () => {
    const messages = extractMessages({
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
        { role: "tool", content: "d" },
        { role: "tool", content: "e" },
      ],
    })!;
    expect(groupConsecutive(messages).map((group) => group.length)).toEqual([2, 1, 2]);
  });

  // 角色交替时每组只有一条，分组不能改变原有顺序。
  test("角色交替时逐条成组", () => {
    const messages = extractMessages({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    })!;
    expect(groupConsecutive(messages).map((group) => group[0].role)).toEqual(["user", "assistant"]);
  });
});

describe("isKnownRole", () => {
  // 已知角色用于选择气泡配色，未知角色要能识别出来并走中性回退样式。
  test("区分已知与未知角色", () => {
    expect(isKnownRole("assistant")).toBe(true);
    expect(isKnownRole("tool")).toBe(true);
    expect(isKnownRole("moderator")).toBe(false);
  });
});
