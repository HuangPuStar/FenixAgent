import { describe, expect, test } from "bun:test";
import type { NodeOutput } from "../../types/execution";
import { CustomNodeRegistry } from "../registry";
import type { CustomNode, InputDef } from "../types";

/** 创建假工具，用于测试 */
function createFakeTool(name: string, produces: string[] = ["out"]): CustomNode {
  return {
    name,
    description: `Fake tool: ${name}`,
    inputs: {
      input1: { type: "string", required: true, description: "An input" } as InputDef,
    },
    produces,
    execute: async () => ({ stdout: `${name} done`, exit_code: 0 }) as NodeOutput,
  };
}

describe("CustomNodeRegistry", () => {
  test("register 后 get 可查到工具", () => {
    const registry = new CustomNodeRegistry();
    const tool = createFakeTool("my_tool");
    registry.register(tool);
    expect(registry.get("my_tool")).toBe(tool);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("list 返回所有已注册工具", () => {
    const registry = new CustomNodeRegistry();
    registry.register(createFakeTool("tool_a", ["a1", "a2"]));
    registry.register(createFakeTool("tool_b", ["b1"]));
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.name).sort()).toEqual(["tool_a", "tool_b"]);
    expect(list[0].inputs).toBeDefined();
    expect(list[0].produces).toBeDefined();
  });

  test("重复注册同名工具时抛 Error", () => {
    const registry = new CustomNodeRegistry();
    registry.register(createFakeTool("dup"));
    expect(() => registry.register(createFakeTool("dup"))).toThrow(/already registered/);
  });

  test("discover 扫描 tools/ 目录并注册工具", async () => {
    const tmpDir = `/tmp/custom-tools-test-${Date.now()}`;
    await Bun.write(
      `${tmpDir}/echo_tool.ts`,
      `
export default class EchoTool {
  name = "echo_tool";
  description = "A test echo tool";
  inputs = {};
  produces = ["output"];
  async execute(ctx: any) {
    return { stdout: "echo: " + JSON.stringify(ctx.inputs), exit_code: 0 };
  }
}
`,
    );

    try {
      const registry = await CustomNodeRegistry.discover(tmpDir);
      const tool = registry.get("echo_tool");
      expect(tool).toBeDefined();
      expect(tool!.name).toBe("echo_tool");
      expect(tool!.description).toBe("A test echo tool");
    } finally {
      await Bun.$`rm -rf ${tmpDir}`;
    }
  });

  test("discover 跳过不含 execute 的导出", async () => {
    const tmpDir = `/tmp/custom-tools-test-${Date.now()}`;
    await Bun.write(
      `${tmpDir}/bad_tool.ts`,
      `
export default class BadTool {
  name = "bad";
  description = "bad";
  inputs = {};
  produces = [];
}
`,
    );

    try {
      const registry = await CustomNodeRegistry.discover(tmpDir);
      expect(registry.get("bad")).toBeUndefined();
      expect(registry.list()).toHaveLength(0);
    } finally {
      await Bun.$`rm -rf ${tmpDir}`;
    }
  });
});
