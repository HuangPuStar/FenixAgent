import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import type { ManagedAcpLinkProcess } from "../process/acp-link-process-manager";
import type { PortAllocator } from "../process/port-allocator";
import { createOpencodeRuntime } from "../runtime/opencode-runtime";

const mockFetch = (async () => new Response("zip-bytes")) as unknown as typeof fetch;
type PortAllocatorStub = Pick<PortAllocator, "allocate" | "release">;

function createLaunchSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    organizationId: "org-test",
    userId: "user-test",
    environmentId: "env-test",
    env: { ACP_RCS_TOKEN: "rcs-secret", OPENAI_API_KEY: "sk-test" },
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
    ...overrides,
  };
}

describe("opencode-runtime prepareEnvironment", () => {
  // prepare 缓存结果，workspace 由 resolveWorkspace 自动计算
  test("caches workspace, launchSpec and prepared state", async () => {
    const runtime = createOpencodeRuntime({
      skillInstallerDependencies: {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
        },
      },
    });
    const launchSpec = createLaunchSpec();

    await runtime.prepareEnvironment({ instanceId: "inst_prepare", launchSpec });

    const state = runtime.getInstanceState("inst_prepare");
    expect(state?.status).toBe("prepared");
    expect(state?.workspace).toMatch(/org-test[/\\]user-test[/\\]env-test$/);
    expect(state?.launchSpec).toEqual(launchSpec);
    expect(state?.installedSkills?.[0]?.path).toContain(".opencode/skills/writer-skill");

    if (state?.workspace) {
      await rm(state.workspace, { recursive: true, force: true });
    }
  });

  // 重复 prepare 覆盖旧 skill
  test("repeated prepare replaces the previous installed skill contents", async () => {
    let version = "v1";
    const runtime = createOpencodeRuntime({
      skillInstallerDependencies: {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), version, "utf8");
        },
      },
    });

    await runtime.prepareEnvironment({
      instanceId: "inst_repeat",
      launchSpec: createLaunchSpec({ skills: [{ name: "writer-skill", url: "https://example.com/first.zip" }] }),
    });
    const state1 = runtime.getInstanceState("inst_repeat");
    expect(await readFile(join(state1!.workspace!, ".opencode", "skills", "writer-skill", "SKILL.md"), "utf8")).toBe(
      "v1",
    );

    version = "v2";
    await runtime.prepareEnvironment({
      instanceId: "inst_repeat",
      launchSpec: createLaunchSpec({ skills: [{ name: "writer-skill", url: "https://example.com/second.zip" }] }),
    });
    const state2 = runtime.getInstanceState("inst_repeat");
    expect(await readFile(join(state2!.workspace!, ".opencode", "skills", "writer-skill", "SKILL.md"), "utf8")).toBe(
      "v2",
    );

    if (state2?.workspace) {
      await rm(state2.workspace, { recursive: true, force: true });
    }
  });

  // skill 从有到无时，应清理 workspace 中残留的旧 skill 目录
  test("removes stale installed skills when launchSpec no longer declares them", async () => {
    const runtime = createOpencodeRuntime({
      skillInstallerDependencies: {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
        },
      },
    });

    await runtime.prepareEnvironment({
      instanceId: "inst_remove_skill",
      launchSpec: createLaunchSpec({ skills: [{ name: "writer-skill", url: "https://example.com/first.zip" }] }),
    });
    const state1 = runtime.getInstanceState("inst_remove_skill");
    await expect(
      access(join(state1!.workspace!, ".opencode", "skills", "writer-skill", "SKILL.md")),
    ).resolves.toBeNull();

    await runtime.prepareEnvironment({
      instanceId: "inst_remove_skill",
      launchSpec: createLaunchSpec({ skills: [] }),
    });
    const state2 = runtime.getInstanceState("inst_remove_skill");
    await expect(access(join(state2!.workspace!, ".opencode", "skills", "writer-skill"))).rejects.toThrow();

    if (state2?.workspace) {
      await rm(state2.workspace, { recursive: true, force: true });
    }
  });

  // prepare 会自动创建缺失的 workspace 目录
  test("creates the workspace directory when it does not exist yet", async () => {
    const runtime = createOpencodeRuntime({
      skillInstallerDependencies: {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
        },
      },
    });

    await runtime.prepareEnvironment({
      instanceId: "inst_create_workspace",
      launchSpec: createLaunchSpec(),
    });

    const state = runtime.getInstanceState("inst_create_workspace");
    await expect(access(state!.workspace!, constants.R_OK | constants.W_OK)).resolves.toBeNull();

    if (state?.workspace) {
      await rm(state.workspace, { recursive: true, force: true });
    }
  });

  // resolveWorkspace 使用 WORKSPACE_ROOT 环境变量
  test("respects WORKSPACE_ROOT environment variable", async () => {
    const originalRoot = process.env.WORKSPACE_ROOT;
    const tmpRoot = await mkdtemp(join(tmpdir(), "ws-root-"));
    process.env.WORKSPACE_ROOT = tmpRoot;

    try {
      const runtime = createOpencodeRuntime({
        skillInstallerDependencies: {
          fetch: mockFetch,
          extractArchive: async (_archivePath, targetDir) => {
            await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
          },
        },
      });

      await runtime.prepareEnvironment({
        instanceId: "inst_custom_root",
        launchSpec: createLaunchSpec(),
      });

      const state = runtime.getInstanceState("inst_custom_root");
      expect(state?.workspace).toBe(join(tmpRoot, "org-test", "user-test", "env-test"));
    } finally {
      if (originalRoot !== undefined) process.env.WORKSPACE_ROOT = originalRoot;
      else delete process.env.WORKSPACE_ROOT;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // 不同 orgId/userId 产生不同 workspace
  test("different orgId/userId produce different workspaces", async () => {
    const runtime = createOpencodeRuntime({
      skillInstallerDependencies: {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
        },
      },
    });

    await runtime.prepareEnvironment({
      instanceId: "inst_org_a",
      launchSpec: createLaunchSpec({ organizationId: "org-a", userId: "user-1", environmentId: "env-a" }),
    });
    await runtime.prepareEnvironment({
      instanceId: "inst_org_b",
      launchSpec: createLaunchSpec({ organizationId: "org-b", userId: "user-1", environmentId: "env-b" }),
    });

    const stateA = runtime.getInstanceState("inst_org_a");
    const stateB = runtime.getInstanceState("inst_org_b");
    expect(stateA?.workspace).not.toBe(stateB?.workspace);

    // cleanup
    for (const state of [stateA, stateB]) {
      if (state?.workspace) {
        await rm(state.workspace, { recursive: true, force: true });
      }
    }
  });

  // environmentId 缺失时 fallback 到 org/user 两段路径
  test("falls back to org/user path when environmentId is not provided", async () => {
    const runtime = createOpencodeRuntime({
      skillInstallerDependencies: {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
        },
      },
    });

    await runtime.prepareEnvironment({
      instanceId: "inst_no_envid",
      launchSpec: createLaunchSpec({ environmentId: undefined }),
    });

    const state = runtime.getInstanceState("inst_no_envid");
    expect(state?.workspace).toMatch(/org-test[/\\]user-test$/);
    expect(state?.workspace).not.toMatch(/env-test/);

    if (state?.workspace) {
      await rm(state.workspace, { recursive: true, force: true });
    }
  });

  // 相同 org/user 下不同 envId 产生不同 workspace
  test("different envId under same org/user produces different workspaces", async () => {
    const runtime = createOpencodeRuntime({
      skillInstallerDependencies: {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
        },
      },
    });

    await runtime.prepareEnvironment({
      instanceId: "inst_env_a",
      launchSpec: createLaunchSpec({ environmentId: "env-alpha" }),
    });
    await runtime.prepareEnvironment({
      instanceId: "inst_env_b",
      launchSpec: createLaunchSpec({ environmentId: "env-beta" }),
    });

    const stateA = runtime.getInstanceState("inst_env_a");
    const stateB = runtime.getInstanceState("inst_env_b");
    expect(stateA?.workspace).not.toBe(stateB?.workspace);
    expect(stateA?.workspace).toMatch(/env-alpha$/);
    expect(stateB?.workspace).toMatch(/env-beta$/);

    for (const state of [stateA, stateB]) {
      if (state?.workspace) {
        await rm(state.workspace, { recursive: true, force: true });
      }
    }
  });
});

describe("opencode-runtime lifecycle", () => {
  // 主流程串通
  test("runs prepare -> start -> connectRelay -> stop in order", async () => {
    let releasedPort = -1;
    let relayState: "open" | "closed" = "open";
    const relay = {
      get state() {
        return relayState;
      },
      send() {},
      close() {
        relayState = "closed";
      },
    };
    const runtime = createOpencodeRuntime({
      skillInstallerDependencies: {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
        },
      },
      portAllocator: {
        allocate: async () => 8888,
        release: (port: number) => {
          releasedPort = port;
        },
      } as PortAllocatorStub as unknown as PortAllocator,
      processManager: {
        start: async (): Promise<ManagedAcpLinkProcess> => ({
          instanceId: "inst_flow",
          pid: 1234,
          port: 8888,
          token: "d".repeat(64),
          status: "running",
          process: {} as ManagedAcpLinkProcess["process"],
        }),
        stop: async () => {},
      } as any,
      createRelayHandle: () => relay as any,
    });

    await runtime.prepareEnvironment({ instanceId: "inst_flow", launchSpec: createLaunchSpec() });
    await runtime.startInstance({ instanceId: "inst_flow" });
    const connectedRelay = await runtime.connectRelay({ instanceId: "inst_flow" });
    await runtime.stopInstance({ instanceId: "inst_flow" });

    const state = runtime.getInstanceState("inst_flow");
    expect(connectedRelay).toBe(relay);
    expect(state?.status).toBe("stopped");
    expect(releasedPort).toBe(8888);

    if (state?.workspace) {
      await rm(state.workspace, { recursive: true, force: true });
    }
  });

  // relay 共享连接
  test("reuses the same relay handle for repeated connectRelay calls", async () => {
    let relayCreations = 0;
    const relay = {
      state: "open" as const,
      send() {},
      close() {},
    };
    const runtime = createOpencodeRuntime({
      skillInstallerDependencies: {
        fetch: mockFetch,
        extractArchive: async (_archivePath, targetDir) => {
          await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
        },
      },
      portAllocator: {
        allocate: async () => 8899,
        release() {},
      } as PortAllocatorStub as unknown as PortAllocator,
      processManager: {
        start: async (): Promise<ManagedAcpLinkProcess> => ({
          instanceId: "inst_shared",
          pid: 5678,
          port: 8899,
          token: "e".repeat(64),
          status: "running",
          process: {} as ManagedAcpLinkProcess["process"],
        }),
        stop: async () => {},
      } as any,
      createRelayHandle: () => {
        relayCreations += 1;
        return relay as any;
      },
    });

    await runtime.prepareEnvironment({ instanceId: "inst_shared", launchSpec: createLaunchSpec() });
    await runtime.startInstance({ instanceId: "inst_shared" });

    const first = await runtime.connectRelay({ instanceId: "inst_shared" });
    const second = await runtime.connectRelay({ instanceId: "inst_shared" });

    expect(first).toBe(second);
    expect(relayCreations).toBe(1);

    const state = runtime.getInstanceState("inst_shared");
    if (state?.workspace) {
      await rm(state.workspace, { recursive: true, force: true });
    }
  });

  // 非法状态报错
  test("throws clear errors for invalid lifecycle transitions", async () => {
    const runtime = createOpencodeRuntime();

    await expect(runtime.startInstance({ instanceId: "inst_missing_prepare" })).rejects.toThrow(
      "must be prepared before start",
    );

    await runtime.prepareEnvironment({
      instanceId: "inst_not_running",
      launchSpec: {
        ...createLaunchSpec(),
        skills: [],
      },
    });

    await expect(runtime.connectRelay({ instanceId: "inst_not_running" })).rejects.toThrow("is not running");

    const state = runtime.getInstanceState("inst_not_running");
    if (state?.workspace) {
      await rm(state.workspace, { recursive: true, force: true });
    }
  });
});
