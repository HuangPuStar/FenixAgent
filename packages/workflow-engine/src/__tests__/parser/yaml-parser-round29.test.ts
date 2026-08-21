import { describe, expect, test } from "bun:test";
import { parseWorkflowYaml } from "../../parser/yaml-parser";
import { CustomNodeRegistry } from "../../plugins/registry";
import type { CustomNode } from "../../plugins/types";

const base = (nodes: string, extra = "") => `schema_version: "1"
name: round29
${extra}nodes:
${nodes}`;

function registryWith(tools: Array<{ name: string; produces: string[]; kind?: "slurm" }>): CustomNodeRegistry {
  const registry = new CustomNodeRegistry();
  for (const tool of tools) {
    registry.register({
      name: tool.name,
      description: tool.name,
      inputs: {},
      produces: tool.produces,
      kind: tool.kind,
      execute: async () => ({ stdout: "", exit_code: 0 }),
    } as CustomNode);
  }
  return registry;
}

describe("YAML 解析器 round29 内存协议状态与隔离", () => {
  // 每种节点协议均应保留其声明字段，并将可选字段规范化为稳定状态。
  test.each([
    [
      "shell 节点保留命令、工作目录和输入",
      base(
        '  - id: shell\n    type: shell\n    command: [echo, ok]\n    cwd: /safe\n    inputs:\n      value: "${{ params.value }}"',
      ),
      "shell",
    ],
    [
      "python 节点保留依赖列表",
      base("  - id: python\n    type: python\n    code: print(1)\n    requirements: [requests]"),
      "python",
    ],
    [
      "agent 节点保留消息数量",
      base("  - id: agent\n    type: agent\n    prompt: hi\n    agent: review\n    output_messages: 2"),
      "agent",
    ],
    [
      "api 节点保留请求字段",
      base("  - id: api\n    type: api\n    url: https://service.invalid\n    method: PUT\n    body: '{}'"),
      "api",
    ],
    [
      "audit 节点保留过期时间",
      base("  - id: audit\n    type: audit\n    display_data: approve\n    expires_in: 1"),
      "audit",
    ],
    [
      "workflow 节点保留子工作流参数",
      base("  - id: child\n    type: workflow\n    ref: child.yaml\n    params:\n      id: one"),
      "workflow",
    ],
    [
      "loop 节点解析内嵌节点",
      base(
        "  - id: loop\n    type: loop\n    condition: true\n    max_iterations: 1\n    body:\n      nodes:\n        - id: inner\n          type: shell\n          command: echo inner",
      ),
      "loop",
    ],
    [
      "transform 节点保留输出映射",
      base('  - id: transform\n    type: transform\n    output:\n      text: "${{ inputs.value }}"'),
      "transform",
    ],
    ["end 节点保留输入映射", base('  - id: end\n    type: end\n    inputs:\n      output: "${{ nodes.a }}"'), "end"],
    [
      "shell 输出默认文件类型",
      base(
        "  - id: shell\n    type: shell\n    command: echo ok\n    outputs:\n      result:\n        pattern: result.txt",
      ),
      "shell",
    ],
    [
      "shell 输出支持目录类型",
      base(
        "  - id: shell\n    type: shell\n    command: echo ok\n    outputs:\n      result:\n        pattern: out\n        type: dir",
      ),
      "shell",
    ],
    [
      "shell 输出支持文件列表类型",
      base(
        "  - id: shell\n    type: shell\n    command: echo ok\n    outputs:\n      result:\n        pattern: '*.txt'\n        type: file-list",
      ),
      "shell",
    ],
    ["空依赖识别为唯一开始节点", base("  - id: start\n    type: audit\n    depends_on: []"), "audit"],
    [
      "显式依赖不会成为开始节点",
      base("  - id: first\n    type: audit\n  - id: later\n    type: audit\n    depends_on: [first]"),
      "audit",
    ],
    ["工作流元数据使用受控基目录", base("  - id: audit\n    type: audit"), "audit"],
    ["可选描述和超时被保留", base("  - id: audit\n    type: audit", "description: desc\ntimeout: 10\n"), "audit"],
    ["环境变量映射被保留", base("  - id: audit\n    type: audit\n    env:\n      MODE: test"), "audit"],
    ["布尔条件外的 condition 被忽略", base("  - id: audit\n    type: audit\n    condition: 1"), "audit"],
    ["非数组依赖被忽略", base("  - id: audit\n    type: audit\n    depends_on: bad"), "audit"],
    [
      "自定义节点无需注册表也能解析",
      base("  - id: custom\n    type: custom\n    tool: local\n    outputs:\n      artifact:\n        pattern: out"),
      "custom",
    ],
  ])("%s", (_name, source, expectedType) => {
    const definition = parseWorkflowYaml(source, "/isolated/workflow");
    expect(definition.nodes[0]?.type).toBe(expectedType);
    expect(definition._baseDir).toBe("/isolated/workflow");
  });

  // 自定义工具的注册表是调用方注入的，每次解析只读取自身注册表而不污染其他解析状态。
  test("自定义工具注册表在解析间隔离", () => {
    const first = registryWith([{ name: "first", produces: ["one"] }]);
    const second = registryWith([{ name: "second", produces: ["two"] }]);
    const firstSource = base(
      "  - id: custom\n    type: custom\n    tool: first\n    outputs:\n      one:\n        pattern: one",
    );
    const secondSource = base(
      "  - id: custom\n    type: custom\n    tool: second\n    outputs:\n      two:\n        pattern: two",
    );

    expect(parseWorkflowYaml(firstSource, undefined, { customRegistry: first }).nodes).toHaveLength(1);
    expect(parseWorkflowYaml(secondSource, undefined, { customRegistry: second }).nodes).toHaveLength(1);
    expect(() => parseWorkflowYaml(firstSource, undefined, { customRegistry: second })).toThrow("not registered");
  });

  // 解析结果必须是新对象，调用方修改前一次结果不能泄漏到后续协议状态。
  test("连续解析不会共享节点或输出资源", () => {
    const source = base(
      "  - id: shell\n    type: shell\n    command: echo ok\n    outputs:\n      artifact:\n        pattern: output.txt\n        type: file",
    );
    const first = parseWorkflowYaml(source);
    const second = parseWorkflowYaml(source);
    first.nodes[0]!.id = "mutated";

    expect(second.nodes[0]!.id).toBe("shell");
    expect(second.nodes[0]).not.toBe(first.nodes[0]);
  });

  // 错误输入必须被局部拒绝，不能创建半初始化的工作流状态或访问外部资源。
  test.each([
    ["标量根节点", "plain text", "root must be a mapping"],
    ["数组根节点", "- item", "root must be a mapping"],
    ["空根节点", "", "root must be a mapping"],
    ["无效 YAML 语法", "name: [", "YAML parse error"],
    ["缺少版本", "name: test\nnodes: []", "schema_version"],
    ["不支持的版本", "schema_version: 2\nname: test\nnodes: []", "Unsupported schema_version"],
    ["空名称", "schema_version: '1'\nname: ' '\nnodes: []", "name"],
    ["非映射参数", "schema_version: '1'\nname: test\nparams: []\nnodes: []", "params"],
    ["缺少节点", "schema_version: '1'\nname: test", "nodes"],
    ["非数组节点", "schema_version: '1'\nname: test\nnodes: {}", "nodes"],
    ["节点为标量", base("  - invalid"), "must be a mapping"],
    ["节点缺少标识", base("  - type: audit"), "empty 'id'"],
    ["节点标识为空", base("  - id: ' '\n    type: audit"), "empty 'id'"],
    ["节点类型无效", base("  - id: invalid\n    type: unsupported"), "invalid type"],
    ["shell 缺少命令", base("  - id: shell\n    type: shell"), "shell node requires 'command'"],
    ["python 缺少代码", base("  - id: python\n    type: python"), "python node requires 'code'"],
    ["agent 缺少提示词", base("  - id: agent\n    type: agent\n    agent: review"), "agent node requires 'prompt'"],
    ["agent 缺少环境", base("  - id: agent\n    type: agent\n    prompt: hi"), "agent node requires 'agent'"],
    ["api 缺少地址", base("  - id: api\n    type: api"), "api node requires 'url'"],
    ["workflow 缺少引用", base("  - id: child\n    type: workflow"), "workflow node requires 'ref'"],
    [
      "loop 缺少条件",
      base("  - id: loop\n    type: loop\n    max_iterations: 1\n    body:\n      nodes: []"),
      "loop node requires 'condition'",
    ],
    [
      "loop 缺少迭代次数",
      base("  - id: loop\n    type: loop\n    condition: true\n    body:\n      nodes: []"),
      "max_iterations",
    ],
    ["loop 缺少节点体", base("  - id: loop\n    type: loop\n    condition: true\n    max_iterations: 1"), "body.nodes"],
    ["transform 缺少输出", base("  - id: transform\n    type: transform"), "non-empty 'output'"],
    ["transform 输出为空", base("  - id: transform\n    type: transform\n    output: {}"), "non-empty 'output'"],
    ["custom 缺少工具", base("  - id: custom\n    type: custom\n    outputs: {}"), "requires 'tool'"],
    ["custom 缺少输出", base("  - id: custom\n    type: custom\n    tool: known"), "requires 'outputs'"],
    [
      "输出不是映射",
      base("  - id: shell\n    type: shell\n    command: echo ok\n    outputs:\n      bad: value"),
      "outputs.bad",
    ],
    ["多个结束节点", base("  - id: first\n    type: end\n  - id: second\n    type: end"), "最多允许一个 end 节点"],
    ["acpx-g 格式", "kind: Pipeline\nmetadata: {}\nspec: {}", "acpx-g format"],
    [
      "custom 未注册工具",
      base("  - id: custom\n    type: custom\n    tool: unknown\n    outputs:\n      result:\n        pattern: out"),
      "not registered",
    ],
    [
      "custom 声明未产出结果",
      base("  - id: custom\n    type: custom\n    tool: known\n    outputs:\n      other:\n        pattern: out"),
      "not declared",
    ],
    [
      "普通工具携带脚本",
      base(
        "  - id: custom\n    type: custom\n    tool: known\n    outputs:\n      result:\n        pattern: out\n    script:\n      content: echo ok",
      ),
      "does not support 'script'",
    ],
    [
      "Slurm 工具缺少脚本",
      base("  - id: custom\n    type: custom\n    tool: slurm\n    outputs:\n      result:\n        pattern: out"),
      "requires 'script.content'",
    ],
    [
      "Slurm 脚本不是映射",
      base(
        "  - id: custom\n    type: custom\n    tool: slurm\n    outputs:\n      result:\n        pattern: out\n    script: echo ok",
      ),
      "script' must be a mapping",
    ],
    [
      "Slurm 脚本内容为空",
      base(
        "  - id: custom\n    type: custom\n    tool: slurm\n    outputs:\n      result:\n        pattern: out\n    script:\n      content: ' '",
      ),
      "script.content",
    ],
  ])("拒绝%s且不保留状态", (_name, source, message) => {
    const customRegistry = registryWith([
      { name: "known", produces: ["result"] },
      { name: "slurm", produces: ["result"], kind: "slurm" },
    ]);
    expect(() => parseWorkflowYaml(source, undefined, { customRegistry })).toThrow(message);
    expect(customRegistry.list()).toHaveLength(2);
  });

  // Slurm 工具的资源声明应仅存在于当前返回节点，避免跨工作流共享调度状态。
  test("Slurm 工具解析独立资源和脚本状态", () => {
    const registry = registryWith([{ name: "slurm", produces: ["result"], kind: "slurm" }]);
    const definition = parseWorkflowYaml(
      base(
        "  - id: job\n    type: custom\n    tool: slurm\n    outputs:\n      result:\n        pattern: out\n    slurm:\n      cores: '4'\n      modules: [gcc, 1]\n    script:\n      content: echo ok\n      env:\n        MODE: batch\n        RETRIES: 1",
      ),
      undefined,
      { customRegistry: registry },
    );

    expect(definition.nodes[0]).toMatchObject({
      type: "custom",
      slurm: { cores: 4, modules: ["gcc"] },
      script: { content: "echo ok", env: { MODE: "batch" } },
    });
  });

  // 通配符工具应在不枚举产物的前提下接受任意输出，避免共享注册表资源被写入。
  test("通配符工具允许独立的任意输出", () => {
    const registry = registryWith([{ name: "wildcard", produces: ["*"] }]);
    const definition = parseWorkflowYaml(
      base(
        "  - id: custom\n    type: custom\n    tool: wildcard\n    outputs:\n      generated:\n        pattern: generated.bin",
      ),
      undefined,
      { customRegistry: registry },
    );

    expect(definition.nodes[0]?.type).toBe("custom");
    expect(registry.list()[0]?.produces).toEqual(["*"]);
  });
});
