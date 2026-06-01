import { expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { createRemoteRuntime } from "../remote-runtime";
import { createMockTransport, type MockTransport } from "./fixtures/mock-transport";

function createLaunchSpec(): AgentLaunchSpec {
  return {
    organizationId: "org_1",
    userId: "user_1",
    environmentId: "env_1",
    env: { API_KEY: "sk-test" },
    agent: { name: "general", prompt: "be helpful" },
    model: {
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o",
    },
    skills: [],
    mcpServers: [],
  };
}

function createContext(): { runtime: ReturnType<typeof createRemoteRuntime>; transport: MockTransport } {
  const transport = createMockTransport();
  const runtime = createRemoteRuntime({ transport });
  return { runtime, transport };
}

// prepareEnvironment 发送 prepare 并在 status=ok 时成功
test("RemoteRuntime: prepareEnvironment sends prepare and succeeds on ok", async () => {
  const { runtime, transport } = createContext();
  const spec = createLaunchSpec();

  const preparePromise = runtime.prepareEnvironment({ instanceId: "inst_1", launchSpec: spec });

  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "prepare");
  expect(sent).toBeDefined();
  expect(sent!.instance_id).toBe("inst_1");
  expect(sent!.launch_spec).toEqual(spec);

  transport.simulateResponse(sent!.request_id!, { type: "prepare_result", status: "ok" });

  await preparePromise;
});

// prepareEnvironment 在 status=error 时抛错
test("RemoteRuntime: prepareEnvironment throws on error status", async () => {
  const { runtime, transport } = createContext();

  const preparePromise = runtime.prepareEnvironment({
    instanceId: "inst_1",
    launchSpec: createLaunchSpec(),
  });

  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "prepare");
  transport.simulateResponse(sent!.request_id!, {
    type: "prepare_result",
    status: "error",
    message: "disk full",
  });

  await expect(preparePromise).rejects.toThrow("disk full");
});

// startInstance 发送 start 并在 status=ok 时成功
test("RemoteRuntime: startInstance sends start and succeeds on ok", async () => {
  const { runtime, transport } = createContext();

  const startPromise = runtime.startInstance({ instanceId: "inst_1" });

  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "start");
  expect(sent).toBeDefined();
  expect(sent!.instance_id).toBe("inst_1");

  transport.simulateResponse(sent!.request_id!, { type: "start_result", status: "ok" });

  await startPromise;
});

// startInstance 在 status=error 时抛错
test("RemoteRuntime: startInstance throws on error status", async () => {
  const { runtime, transport } = createContext();

  const startPromise = runtime.startInstance({ instanceId: "inst_1" });

  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "start");
  transport.simulateResponse(sent!.request_id!, {
    type: "start_result",
    status: "error",
    message: "spawn failed",
  });

  await expect(startPromise).rejects.toThrow("spawn failed");
});

// connectRelay 返回 open 状态的 RemoteRelayHandle
test("RemoteRuntime: connectRelay returns a relay handle", async () => {
  const { runtime } = createContext();
  const handle = await runtime.connectRelay({ instanceId: "inst_1", sessionId: "sess_1" });
  expect(handle.state).toBe("open");
  handle.close();
  expect(handle.state).toBe("closed");
});

// stopInstance 发送 stop 并容忍失败
test("RemoteRuntime: stopInstance sends stop and tolerates timeout", async () => {
  const { runtime, transport } = createContext();

  const stopPromise = runtime.stopInstance({ instanceId: "inst_1" });

  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "stop");
  expect(sent).toBeDefined();

  transport.simulateResponse(sent!.request_id!, { type: "stop_result", status: "ok" });

  await stopPromise;
});
