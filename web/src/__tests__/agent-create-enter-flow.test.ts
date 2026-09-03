import { describe, expect, mock, test } from "bun:test";
import type { EnterEnvironmentResponse, EnvironmentDetail } from "../api/environments";
import { resolveCreatedAgentChatTarget } from "../pages/agent-panel/AgentPanelLayout";

describe("新建智能体进入对话", () => {
  // 新建智能体创建环境后必须显式进入环境，并携带实例 UID 导航，避免聊天页永久等待连接。
  test("创建环境后进入实例并返回完整聊天目标", async () => {
    const createdEnvironment: EnvironmentDetail = {
      id: "env-created",
      name: "env-agent-co",
      agentConfigId: "agent-config-id",
    };
    const enteredEnvironment: EnterEnvironmentResponse = {
      environmentId: "env-created",
      instanceUid: "instance-created",
      name: "instance-created",
      status: "running",
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    const list = mock(async () => [] as EnvironmentDetail[]);
    const create = mock(async () => createdEnvironment);
    const enter = mock(async () => enteredEnvironment);

    const target = await resolveCreatedAgentChatTarget("agent-config-id", { list, create, enter });

    expect(create).toHaveBeenCalledWith({
      name: "env-agent-co",
      agentConfigId: "agent-config-id",
      autoStart: true,
    });
    expect(enter).toHaveBeenCalledWith("env-created");
    expect(target).toEqual({ environmentId: "env-created", instanceUid: "instance-created" });
  });

  // 已有关联环境时也必须走 enter，不能仅凭环境 ID 直接打开缺少实例上下文的聊天页。
  test("复用已有环境时仍进入实例", async () => {
    const list = mock(async () => [{ id: "env-existing", name: "existing", agentConfigId: "agent-config-id" }]);
    const create = mock(async () => {
      throw new Error("不应创建环境");
    });
    const enter = mock(async () => ({
      environmentId: "env-existing",
      instanceUid: "instance-existing",
      name: "instance-existing",
      status: "running",
      createdAt: "2026-09-02T00:00:00.000Z",
    }));

    const target = await resolveCreatedAgentChatTarget("agent-config-id", { list, create, enter });

    expect(create).not.toHaveBeenCalled();
    expect(enter).toHaveBeenCalledWith("env-existing");
    expect(target).toEqual({ environmentId: "env-existing", instanceUid: "instance-existing" });
  });
});
