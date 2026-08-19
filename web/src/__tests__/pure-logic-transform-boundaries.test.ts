import { describe, expect, test } from "bun:test";
import { err, ok, unwrapApiResult } from "../lib/api-result";
import { buildModelOptions } from "../lib/model-config-utils";
import { getTodoChanges, getTodosFromRawInput, isTodoWriteToolCall, parseTodosFromRawInput } from "../lib/todo";
import type { TodoItem } from "../lib/types";
import type { ModelEntry, ResourceAccess } from "../types/config";

const baseModel: ModelEntry = {
  id: "model-1",
  modelId: "gpt-4.1",
  displayName: "GPT 4.1",
  provider: "openai",
  providerDisplayName: "OpenAI",
  contextLimit: null,
  outputLimit: null,
};

const access = (sourceOrganizationName?: string): ResourceAccess => ({
  ownership: "external",
  sourceOrganizationId: "org-1",
  ...(sourceOrganizationName === undefined ? {} : { sourceOrganizationName }),
  resourceUid: "provider-1",
  resourceKey: "provider-key",
  manageable: false,
  writable: false,
});

const todo = (content: string, status: TodoItem["status"] = "pending", activeForm?: string): TodoItem => ({
  content,
  status,
  ...(activeForm === undefined ? {} : { activeForm }),
});

describe("api-result 纯转换边界", () => {
  // 成功结果必须保留字符串数据的原始值。
  test.each([[""], ["0"], ["内容"], ["\n"]])("解包字符串成功结果 %#", (data) => {
    expect(unwrapApiResult(ok(data))).toBe(data);
  });

  // 成功结果必须保留数字数据的原始值。
  test.each([[0], [-1], [1], [Number.MAX_SAFE_INTEGER]])("解包数字成功结果 %#", (data) => {
    expect(unwrapApiResult(ok(data))).toBe(data);
  });

  // 成功结果可以承载空值或布尔值而不被误判为错误。
  test.each([[null], [undefined], [false], [true]])("解包可假值成功结果 %#", (data) => {
    expect(unwrapApiResult(ok(data))).toBe(data);
  });

  // 失败结果必须使用非空服务端消息构造 Error。
  test.each([
    ["NOT_FOUND", "未找到资源"],
    ["VALIDATION_ERROR", "字段无效"],
    ["UNAUTHORIZED", "无权访问"],
    ["INTERNAL", "内部错误"],
  ])("失败结果抛出服务端消息 %#", (code, message) => {
    expect(() => unwrapApiResult(err(code, message))).toThrow(message);
  });

  // 空字符串消息必须回退为稳定的通用错误文本。
  test("空字符串错误消息回退通用错误", () => {
    expect(() => unwrapApiResult(err("FAILED", ""))).toThrow("Unknown API error");
  });

  // 空白消息仍是非空服务端文本，必须原样保留而不能被擅自清洗。
  test.each([["\n"], ["   "]])("空白错误消息原样保留 %#", (message) => {
    expect(() => unwrapApiResult(err("FAILED", message))).toThrow(message);
  });

  // 错误构造器不得为未传入 data 伪造 data 字段。
  test.each([[undefined], [null], [0], [false], [""]])("错误构造器准确保留 data 存在性 %#", (data) => {
    const result = err("FAILED", "失败", 400, data);
    expect(result.error).toEqual(
      data === undefined
        ? { code: "FAILED", message: "失败", status: 400 }
        : { code: "FAILED", message: "失败", status: 400, data },
    );
  });
});

describe("模型选项转换与不可变性", () => {
  // 没有资源键时必须回退到旧版 provider/modelId 值。
  test.each([
    ["openai", "gpt-4.1"],
    ["anthropic", "claude-3"],
    ["本地", "模型"],
    ["", "default"],
  ])("兼容旧模型值格式 %#", (provider, modelId) => {
    const models = [{ ...baseModel, provider, modelId }];
    expect(buildModelOptions(models)).toEqual([{ value: `${provider}/${modelId}`, label: "OpenAI/GPT 4.1" }]);
  });

  // 资源键必须优先于旧 provider 生成选项值。
  test.each([
    ["provider-key"],
    ["org/provider"],
    ["shared:one"],
    ["0"],
  ])("优先使用 providerResourceKey %#", (providerResourceKey) => {
    const models = [{ ...baseModel, provider: "ignored", providerResourceKey }];
    expect(buildModelOptions(models)[0]?.value).toBe(`${providerResourceKey}/gpt-4.1`);
  });

  // 来源组织名只应影响展示标签，不应污染选项值。
  test.each([["研发部"], ["Team A"], ["0"], ["组织/子组"]])("来源组织名转换标签 %#", (sourceOrganizationName) => {
    const models = [{ ...baseModel, providerResourceAccess: access(sourceOrganizationName) }];
    const [option] = buildModelOptions(models);
    expect(option).toEqual({ value: "openai/gpt-4.1", label: `${sourceOrganizationName}/OpenAI/GPT 4.1` });
  });

  // 空来源组织名应视为没有前缀，避免多余斜杠。
  test.each([[undefined], [""], [null]])("空来源组织名不添加标签前缀 %#", (sourceOrganizationName) => {
    const models = [
      {
        ...baseModel,
        providerResourceAccess:
          sourceOrganizationName === undefined ? undefined : access(sourceOrganizationName ?? undefined),
      },
    ];
    expect(buildModelOptions(models)[0]?.label).toBe("OpenAI/GPT 4.1");
  });

  // 转换必须维持输入顺序且不改写模型对象。
  test("转换多个模型时保持顺序和输入不可变", () => {
    const models = [
      { ...baseModel, id: "first", modelId: "first-model", displayName: "First" },
      { ...baseModel, id: "second", modelId: "second-model", displayName: "Second", providerResourceKey: "shared" },
    ];
    const snapshot = structuredClone(models);

    expect(buildModelOptions(models)).toEqual([
      { value: "openai/first-model", label: "OpenAI/First" },
      { value: "shared/second-model", label: "OpenAI/Second" },
    ]);
    expect(models).toEqual(snapshot);
  });
});

describe("TodoWrite 转换、错误边界与不可变性", () => {
  // 缺少 todos/tasks 或字段不是数组时必须明确返回 null。
  test.each([undefined, {}, { todos: null }, { todos: "x" }, { tasks: {} }])("无效待办容器返回 null %#", (rawInput) => {
    expect(getTodosFromRawInput(rawInput)).toBeNull();
  });

  // 面板解析器必须把无效待办容器标准化为空数组。
  test.each([{}, { todos: null }, { todos: "x" }, { tasks: 1 }])("无效待办容器解析为空数组 %#", (rawInput) => {
    expect(parseTodosFromRawInput(rawInput)).toEqual([]);
  });

  // todos 字段必须优先于兼容的 tasks 字段。
  test("todos 字段优先于 tasks 字段", () => {
    expect(getTodosFromRawInput({ todos: [{ content: "新" }], tasks: [{ content: "旧" }] })).toEqual([todo("新")]);
  });

  // 数组内的原始值必须被过滤；对象项则按默认值安全投影。
  test.each([
    [[null, "text", 1, true], []],
    [[[], () => undefined], [todo("")]],
    [[new Date("2020-01-01")], [todo("")]],
  ])("待办数组项转换边界 %#", (todos, expected) => {
    expect(getTodosFromRawInput({ todos })).toEqual(expected);
  });

  // content 必须为字符串或被安全转换为字符串。
  test.each([
    ["文本", "文本"],
    [0, "0"],
    [false, "false"],
    [null, ""],
    [undefined, ""],
  ])("待办内容转换边界 %#", (content, expected) => {
    expect(getTodosFromRawInput({ todos: [{ content }] })).toEqual([todo(expected)]);
  });

  // 非法状态必须回退 pending，合法状态必须原样保留。
  test.each<[unknown, TodoItem["status"]]>([
    ["pending", "pending"],
    ["in_progress", "in_progress"],
    ["completed", "completed"],
    ["invalid", "pending"],
    [null, "pending"],
  ])("待办状态规范化 %#", (status, expected) => {
    expect(getTodosFromRawInput({ todos: [{ content: "任务", status }] })).toEqual([todo("任务", expected)]);
  });

  // activeForm 仅接受字符串，其他值不能泄漏到展示数据。
  test.each([
    ["执行中", "执行中"],
    ["", ""],
    [0, undefined],
    [false, undefined],
    [null, undefined],
  ])("活动文案边界 %#", (activeForm, expected) => {
    expect(getTodosFromRawInput({ todos: [{ content: "任务", activeForm }] })).toEqual([
      todo("任务", "pending", expected),
    ]);
  });

  // TodoWrite 名称识别必须忽略大小写并兼容下划线形式。
  test.each([
    ["TodoWrite", true],
    ["todowrite", true],
    ["TODO_WRITE", true],
    ["before-todowrite-after", true],
    ["todo write", false],
  ])("TodoWrite 标题识别 %#", (title, expected) => {
    expect(isTodoWriteToolCall(title, {})).toBe(expected);
  });

  // 即使标题匹配，缺少 rawInput 时也不能误识别为 TodoWrite。
  test("缺少原始输入时不识别 TodoWrite", () => {
    expect(isTodoWriteToolCall("TodoWrite")).toBe(false);
  });

  // 新增条目必须按当前快照顺序生成 added 变更。
  test("空快照到多个待办生成新增变更", () => {
    expect(getTodoChanges([], [todo("一"), todo("二", "in_progress")])).toEqual([
      { id: "added:一::0", kind: "added", todo: todo("一") },
      { id: "added:二::0", kind: "added", todo: todo("二", "in_progress") },
    ]);
  });

  // 移除条目必须在当前快照处理完后按上一快照顺序生成。
  test("多个旧待办缺失时生成移除变更", () => {
    expect(getTodoChanges([todo("一"), todo("二")], [])).toEqual([
      { id: "removed:一::0", kind: "removed", todo: todo("一") },
      { id: "removed:二::0", kind: "removed", todo: todo("二") },
    ]);
  });

  // 状态变化必须用当前状态作为变更种类。
  test.each<[TodoItem["status"], TodoItem["status"]]>([
    ["pending", "in_progress"],
    ["pending", "completed"],
    ["in_progress", "completed"],
    ["completed", "pending"],
  ])("状态变化投影为当前状态 %#", (previousStatus, currentStatus) => {
    expect(getTodoChanges([todo("任务", previousStatus)], [todo("任务", currentStatus)])).toEqual([
      { id: `${currentStatus}:任务::0`, kind: currentStatus, todo: todo("任务", currentStatus) },
    ]);
  });

  // 仅活动文案变化时必须投影为 updated。
  test.each([
    [undefined, "开始"],
    ["开始", "继续"],
    ["继续", undefined],
  ])("活动文案变化投影 updated %#", (previousActiveForm, currentActiveForm) => {
    expect(
      getTodoChanges([todo("任务", "pending", previousActiveForm)], [todo("任务", "pending", currentActiveForm)]),
    ).toEqual([
      {
        id: `updated:任务:${currentActiveForm ?? ""}:0`,
        kind: "updated",
        todo: todo("任务", "pending", currentActiveForm),
      },
    ]);
  });

  // 完全相同的快照不能生成噪声变更。
  test.each([
    [[todo("任务")]],
    [[todo("任务", "in_progress", "执行")]],
    [[todo("一"), todo("二", "completed")]],
  ])("相同快照不产生变更 %#", (items) => {
    expect(getTodoChanges(items, structuredClone(items))).toEqual([]);
  });

  // 同名待办必须按出现顺序配对，不能错误合并重复条目。
  test("重复内容按出现顺序配对", () => {
    expect(
      getTodoChanges(
        [todo("重复"), todo("重复", "in_progress")],
        [todo("重复", "completed"), todo("重复", "in_progress")],
      ),
    ).toEqual([{ id: "completed:重复::0", kind: "completed", todo: todo("重复", "completed") }]);
  });

  // 内容改名没有稳定 ID 时必须表达为移除与新增。
  test.each([
    ["旧任务", "新任务"],
    ["A", "B"],
    ["", "内容"],
  ])("内容变化生成移除和新增 %#", (oldContent, newContent) => {
    expect(getTodoChanges([todo(oldContent)], [todo(newContent)])).toEqual([
      { id: `added:${newContent}::0`, kind: "added", todo: todo(newContent) },
      { id: `removed:${oldContent}::0`, kind: "removed", todo: todo(oldContent) },
    ]);
  });

  // 差分计算不得修改前后两个原始快照。
  test("差分计算保持两个输入快照不可变", () => {
    const previous = [todo("保留"), todo("移除")];
    const current = [todo("保留", "completed"), todo("新增")];
    const previousSnapshot = structuredClone(previous);
    const currentSnapshot = structuredClone(current);

    getTodoChanges(previous, current);

    expect(previous).toEqual(previousSnapshot);
    expect(current).toEqual(currentSnapshot);
  });
});
