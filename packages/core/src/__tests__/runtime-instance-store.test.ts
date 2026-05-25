import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@mothership/plugin-sdk";
import { createRuntimeInstanceStore } from "../runtime/runtime-instance-store";
import { createFakeEnginePlugin } from "./fixtures/fake-engine-plugin";

function createLaunchSpec(): AgentLaunchSpec {
  return {
    workspace: "/tmp/mothership-workspace",
    env: { OPENAI_API_KEY: "sk-test" },
    agent: { name: "writer", prompt: "Be precise" },
    model: {
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4.1",
      modelName: "gpt-4.1",
    },
    skills: [{ name: "writer-skill", url: "https://example.com/writer.zip" }],
    mcpServers: [],
  };
}

function createClock(times: Date[]): () => Date {
  const queue = [...times];
  return () => {
    const next = queue.shift();
    if (!next) {
      throw new Error("clock exhausted");
    }
    return new Date(next);
  };
}

describe("RuntimeInstanceStore", () => {
  // create() 会写入 created 初始状态和固定时间戳
  test("creates records with created status and injected timestamps", () => {
    const initialTime = new Date("2026-05-15T10:00:00.000Z");
    const store = createRuntimeInstanceStore({
      now: createClock([initialTime]),
    });

    const snapshot = store.create({
      instanceId: "inst_store",
      engineType: "opencode",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });

    expect(snapshot.status).toBe("created");
    expect(snapshot.relayConnected).toBe(false);
    expect(snapshot.createdAt).toEqual(initialTime);
    expect(snapshot.updatedAt).toEqual(initialTime);
  });

  // 快照返回值是隔离副本，不会污染 store 内部状态
  test("isolates snapshots returned by get and list", () => {
    const store = createRuntimeInstanceStore({
      now: createClock([new Date("2026-05-15T10:00:00.000Z")]),
    });

    store.create({
      instanceId: "inst_store",
      engineType: "opencode",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });

    const snapshot = store.get("inst_store");
    const listSnapshot = store.list()[0];
    if (!snapshot || !listSnapshot) {
      throw new Error("expected snapshots to exist");
    }

    const mutableSnapshot = snapshot as typeof snapshot & {
      -readonly [K in keyof typeof snapshot]: (typeof snapshot)[K];
    };
    mutableSnapshot.status = "error";
    mutableSnapshot.launchSpec.workspace = "/tmp/changed";
    listSnapshot.launchSpec.workspace = "/tmp/list-changed";

    const persisted = store.get("inst_store");
    expect(persisted?.status).toBe("created");
    expect(persisted?.launchSpec.workspace).toBe("/tmp/mothership-workspace");
  });

  // update() 会推进状态、更新时间并在离开 error 后清空错误消息
  test("updates status, timestamps and clears stale error messages", () => {
    const store = createRuntimeInstanceStore({
      now: createClock([
        new Date("2026-05-15T10:00:00.000Z"),
        new Date("2026-05-15T10:01:00.000Z"),
        new Date("2026-05-15T10:02:00.000Z"),
        new Date("2026-05-15T10:03:00.000Z"),
      ]),
    });

    store.create({
      instanceId: "inst_store",
      engineType: "opencode",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });

    const preparing = store.update("inst_store", { status: "preparing" });
    const errored = store.update("inst_store", {
      status: "error",
      errorMessage: "boom",
    });
    const running = store.update("inst_store", { status: "running" });

    expect(preparing.updatedAt).toEqual(new Date("2026-05-15T10:01:00.000Z"));
    expect(errored.updatedAt).toEqual(new Date("2026-05-15T10:02:00.000Z"));
    expect(errored.errorMessage).toBe("boom");
    expect(running.updatedAt).toEqual(new Date("2026-05-15T10:03:00.000Z"));
    expect(running.errorMessage).toBeUndefined();
  });

  // runtime entry、relay 缓存与记录中的 relayConnected 会保持同步
  test("manages runtime entries and relay state changes", () => {
    const store = createRuntimeInstanceStore({
      now: createClock([
        new Date("2026-05-15T10:00:00.000Z"),
        new Date("2026-05-15T10:01:00.000Z"),
        new Date("2026-05-15T10:02:00.000Z"),
      ]),
    });
    const plugin = createFakeEnginePlugin({ engineType: "opencode" });

    store.create({
      instanceId: "inst_store",
      engineType: "opencode",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });

    const runtime = plugin.createRuntime();
    store.attachRuntime("inst_store", {
      plugin,
      runtime,
      relay: null,
    });

    const attached = store.getRuntimeEntry("inst_store");
    expect(attached?.plugin).toBe(plugin);
    expect(attached?.runtime).toBe(runtime);
    expect(attached?.relay).toBeNull();

    const relayState = plugin.runtimeState.relay;
    store.setRelay("inst_store", relayState);
    expect(store.getRuntimeEntry("inst_store")?.relay).toBe(relayState);
    expect(store.get("inst_store")?.relayConnected).toBe(true);

    store.clearRelay("inst_store");
    expect(store.getRuntimeEntry("inst_store")?.relay).toBeNull();
    expect(store.get("inst_store")?.relayConnected).toBe(false);
  });

  // create() 会拒绝重复 instanceId
  test("rejects duplicate instance creation", () => {
    const store = createRuntimeInstanceStore({
      now: createClock([new Date("2026-05-15T10:00:00.000Z")]),
    });
    const input = {
      instanceId: "inst_store",
      engineType: "opencode",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    };

    store.create(input);

    expect(() => store.create(input)).toThrow(
      expect.objectContaining({
        code: "INSTANCE_ALREADY_EXISTS",
      }),
    );
  });
});
