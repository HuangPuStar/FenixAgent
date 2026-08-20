import { describe, expect, test } from "bun:test";
import { createEnginePlugin } from "../plugin";

describe("Peri engine plugin", () => {
  // Peri 必须以独立 engine id 注册，不能伪装为 CCB。
  test("registers an independent peri engine", () => {
    const plugin = createEnginePlugin();

    expect(plugin.meta.id).toBe("peri");
    expect(plugin.meta.displayName).toBe("Peri Engine (peri acp)");
  });

  // 外部可覆盖 Peri 可执行文件和参数，便于私有安装与测试环境接入。
  test("accepts an explicit command and arguments", () => {
    const plugin = createEnginePlugin({ command: "/opt/peri/bin/peri", args: ["acp", "--verbose"] });

    expect(plugin.meta.displayName).toBe("Peri Engine (/opt/peri/bin/peri acp --verbose)");
  });
});
