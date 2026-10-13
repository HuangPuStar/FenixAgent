import { describe, expect, test } from "bun:test";
import { selectRemoteMachineId } from "../services/remote-file-service";

describe("remote file machine resolution", () => {
  // 显式 Sandbox AgentNode 必须使用 sandbox_instance 绑定的 Machine ID。
  test("uses the sandbox instance machine id for a sandbox agent node", () => {
    expect(
      selectRemoteMachineId({
        agentNode: { kind: "sandbox", sandboxPoolId: "default" },
        sandboxMachineId: "mach_sandbox_sbi_test",
        sandboxSelected: true,
        defaultMachineId: "mach_default",
      }),
    ).toBe("mach_sandbox_sbi_test");
  });

  // 未显式选择节点时，默认 Sandbox 存在则优先于默认 Machine。
  test("prefers the default sandbox instance over the default machine", () => {
    expect(
      selectRemoteMachineId({
        agentNode: {},
        sandboxMachineId: "mach_sandbox_sbi_default",
        sandboxSelected: true,
        defaultMachineId: "mach_default",
      }),
    ).toBe("mach_sandbox_sbi_default");
  });

  // 普通 Machine 配置仍使用 AgentNode 中的 Machine ID。
  test("keeps explicit machine resolution unchanged", () => {
    expect(
      selectRemoteMachineId({
        agentNode: { kind: "machine", machineId: "mach_explicit" },
        sandboxMachineId: "mach_sandbox_sbi_test",
        sandboxSelected: false,
        defaultMachineId: "mach_default",
      }),
    ).toBe("mach_explicit");
  });
});
