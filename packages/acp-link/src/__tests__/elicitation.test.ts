import { describe, expect, test } from "bun:test";
import { buildElicitationContent, extractPropertyKeys, parseElicitationSchema } from "../elicitation.js";

// 单选 form schema（peri transport_broker 构造形态：title=header、description=question、oneOf 枚举）
const singleSelectSchema = {
  type: "object",
  properties: {
    ask_user_question_0: {
      type: "string",
      title: "学习主题",
      description: "今天你想学习什么主题？",
      oneOf: [
        { const: "编程相关", description: "学习编程语言、算法、架构设计等技术知识" },
        { const: "数学", description: "学习数学概念、公式推导或应用数学" },
        { const: "科学" },
        { const: "", description: "空 label 应被过滤" },
      ],
    },
  },
  required: ["ask_user_question_0"],
};

// 多选 form schema（type: array + items.anyOf 或 items 数组）
const multiSelectSchema = {
  type: "object",
  properties: {
    ask_user_question_1: {
      type: "array",
      title: "兴趣方向",
      description: "选择感兴趣的方向",
      items: {
        anyOf: [
          { const: "前端", description: "React/Vue 等" },
          { const: "后端", description: "服务端架构" },
        ],
      },
    },
  },
  required: ["ask_user_question_1"],
};

describe("parseElicitationSchema", () => {
  // 单选 schema：oneOf 枚举解析为 question/header/options 形态
  test("parses single-select form schema into questions", () => {
    const questions = parseElicitationSchema(singleSelectSchema);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({
      question: "今天你想学习什么主题？",
      header: "学习主题",
      options: [
        { label: "编程相关", description: "学习编程语言、算法、架构设计等技术知识" },
        { label: "数学", description: "学习数学概念、公式推导或应用数学" },
        { label: "科学", description: null },
      ],
      multiSelect: false,
    });
  });

  // 多选 schema：items.anyOf 枚举解析（选项形态与单选一致）
  test("parses multi-select form schema options", () => {
    const questions = parseElicitationSchema(multiSelectSchema);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({
      question: "选择感兴趣的方向",
      header: "兴趣方向",
      options: [
        { label: "前端", description: "React/Vue 等" },
        { label: "后端", description: "服务端架构" },
      ],
      multiSelect: true,
    });
  });

  // 空/非法 schema：返回空数组，不抛错
  test("returns empty array for missing or invalid schema", () => {
    expect(parseElicitationSchema(undefined)).toEqual([]);
    expect(parseElicitationSchema(null)).toEqual([]);
    expect(parseElicitationSchema("not-an-object")).toEqual([]);
    expect(parseElicitationSchema({ type: "object" })).toEqual([]);
  });

  // 无 title/description 的属性：question 为空被过滤，不产生无意义提问
  test("filters properties without a question text", () => {
    const questions = parseElicitationSchema({
      type: "object",
      properties: {
        ask_user_question_0: { type: "string", oneOf: [{ const: "A" }] },
      },
    });
    expect(questions).toEqual([]);
  });
});

describe("extractPropertyKeys", () => {
  // q_id 键提取：与 questions 数组顺序一一对应（content 组装依赖此顺序）
  test("extracts property keys in schema order", () => {
    expect(extractPropertyKeys(singleSelectSchema)).toEqual(["ask_user_question_0"]);
    expect(extractPropertyKeys(multiSelectSchema)).toEqual(["ask_user_question_1"]);
  });

  // 空 schema：返回空数组
  test("returns empty array for invalid schema", () => {
    expect(extractPropertyKeys(undefined)).toEqual([]);
    expect(extractPropertyKeys({})).toEqual([]);
  });
});

describe("buildElicitationContent", () => {
  // 单选：extra.outcome.optionId（选项 label）按 propertyKeys[0] 组装为 content[q_id]
  test("maps single-select optionId to first property key", () => {
    const content = buildElicitationContent({ outcome: { optionId: "编程相关" } }, ["ask_user_question_0"]);
    expect(content).toEqual({ ask_user_question_0: "编程相关" });
  });

  // 空选项：视为未应答，返回空 content（agent 按空答案继续）
  test("returns empty content when optionId is empty", () => {
    expect(buildElicitationContent({ outcome: { optionId: "" } }, ["ask_user_question_0"])).toEqual({});
    expect(buildElicitationContent(undefined, ["ask_user_question_0"])).toEqual({});
    expect(buildElicitationContent({}, ["ask_user_question_0"])).toEqual({});
  });

  // 多问题合并答案：extra.answers 为 string 数组（translator 发出的 optionIds 形态，
  // 按 propertyKeys 顺序一一对应），组装为 content[q_id]=label
  test("maps answers array to property keys in order", () => {
    const content = buildElicitationContent({ answers: ["编程相关", "数学"] }, [
      "ask_user_question_0",
      "ask_user_question_1",
    ]);
    expect(content).toEqual({ ask_user_question_0: "编程相关", ask_user_question_1: "数学" });
  });

  // 多选答案保持数组值，按对应 property key 组装为 elicitation content。
  test("preserves multi-select arrays in answers", () => {
    expect(buildElicitationContent({ answers: [["前端", "后端"]] }, ["ask_user_question_1"])).toEqual({
      ask_user_question_1: ["前端", "后端"],
    });
  });

  // answers 数组缺项/空串：对应 q_id 不填（不产生空 label 答案）
  test("skips missing or empty entries in answers array", () => {
    const content = buildElicitationContent({ answers: ["编程相关", "", undefined] }, [
      "ask_user_question_0",
      "ask_user_question_1",
      "ask_user_question_2",
    ]);
    expect(content).toEqual({ ask_user_question_0: "编程相关" });
  });

  // answers 数组长度不足 propertyKeys：仅组装有值部分（单问题单选回退兼容）
  test("tolerates answers array shorter than property keys", () => {
    const content = buildElicitationContent({ answers: ["编程相关"] }, ["ask_user_question_0", "ask_user_question_1"]);
    expect(content).toEqual({ ask_user_question_0: "编程相关" });
  });
});
