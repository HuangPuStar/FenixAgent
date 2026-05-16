import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@mothership/plugin-sdk";
import type { ManagedAcpLinkProcess } from "../process/acp-link-process-manager";
import type { PortAllocator } from "../process/port-allocator";
import { createOpencodeRuntime } from "../runtime/opencode-runtime";

const mockFetch = (async () => new Response("zip-bytes")) as unknown as typeof fetch;
type PortAllocatorStub = Pick<PortAllocator, "allocate" | "release">;

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugin-opencode-runtime-"));
}

function createLaunchSpec(workspace: string, skillUrl = "https://example.com/writer.zip"): AgentLaunchSpec {
  return {
    workspace,
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
    skills: [{ name: "writer-skill", url: skillUrl }],
    mcpServers: [],
  };
}

describe("opencode-runtime prepareEnvironment", () => {
  // prepare 缓存结果
  test("caches workspace, launchSpec and prepared state", async () => {
    const workspace = await createWorkspace();
    try {
      const runtime = createOpencodeRuntime({
        skillInstallerDependencies: {
          fetch: mockFetch,
          extractArchive: async (_archivePath, targetDir) => {
            await writeFile(join(targetDir, "SKILL.md"), "# installed\n", "utf8");
          },
        },
      });
      const launchSpec = createLaunchSpec(workspace);

      await runtime.prepareEnvironment({ instanceId: "inst_prepare", launchSpec });

      const state = runtime.getInstanceState("inst_prepare");
      expect(state?.status).toBe("prepared");
      expect(state?.workspace).toBe(workspace);
      expect(state?.launchSpec).toEqual(launchSpec);
      expect(state?.installedSkills?.[0]?.path).toContain(".opencode/skills/writer-skill");
      expect(await readFile(join(workspace, ".env"), "utf8")).toContain("ACP_RCS_TOKEN=rcs-secret");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 重复 prepare 覆盖旧 skill
  test("repeated prepare replaces the previous installed skill contents", async () => {
    const workspace = await createWorkspace();
    try {
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
        launchSpec: createLaunchSpec(workspace, "https://example.com/first.zip"),
      });
      expect(await readFile(join(workspace, ".opencode", "skills", "writer-skill", "SKILL.md"), "utf8")).toBe("v1");

      version = "v2";
      await runtime.prepareEnvironment({
        instanceId: "inst_repeat",
        launchSpec: createLaunchSpec(workspace, "https://example.com/second.zip"),
      });
      expect(await readFile(join(workspace, ".opencode", "skills", "writer-skill", "SKILL.md"), "utf8")).toBe("v2");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // prepare 会自动创建缺失的 workspace 目录
  test("creates the workspace directory when it does not exist yet", async () => {
    const root = await createWorkspace();
    const workspace = join(root, "nested", "workspace");
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
        instanceId: "inst_create_workspace",
        launchSpec: createLaunchSpec(workspace),
      });

      await expect(access(workspace, constants.R_OK | constants.W_OK)).resolves.toBeNull();
      expect(await readFile(join(workspace, ".env"), "utf8")).toContain("ACP_RCS_TOKEN=rcs-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("opencode-runtime lifecycle", () => {
  // 主流程串通
  test("runs prepare -> start -> connectRelay -> stop in order", async () => {
    const workspace = await createWorkspace();
    try {
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

      await runtime.prepareEnvironment({ instanceId: "inst_flow", launchSpec: createLaunchSpec(workspace) });
      await runtime.startInstance({ instanceId: "inst_flow" });
      const connectedRelay = await runtime.connectRelay({ instanceId: "inst_flow" });
      await runtime.stopInstance({ instanceId: "inst_flow" });

      const state = runtime.getInstanceState("inst_flow");
      expect(connectedRelay).toBe(relay);
      expect(state?.status).toBe("stopped");
      expect(releasedPort).toBe(8888);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // relay 共享连接
  test("reuses the same relay handle for repeated connectRelay calls", async () => {
    const workspace = await createWorkspace();
    try {
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

      await runtime.prepareEnvironment({ instanceId: "inst_shared", launchSpec: createLaunchSpec(workspace) });
      await runtime.startInstance({ instanceId: "inst_shared" });

      const first = await runtime.connectRelay({ instanceId: "inst_shared" });
      const second = await runtime.connectRelay({ instanceId: "inst_shared" });

      expect(first).toBe(second);
      expect(relayCreations).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 非法状态报错
  test("throws clear errors for invalid lifecycle transitions", async () => {
    const workspace = await createWorkspace();
    try {
      const runtime = createOpencodeRuntime();

      await expect(runtime.startInstance({ instanceId: "inst_missing_prepare" })).rejects.toThrow(
        "must be prepared before start",
      );

      await runtime.prepareEnvironment({
        instanceId: "inst_not_running",
        launchSpec: {
          ...createLaunchSpec(workspace),
          skills: [],
        },
      });

      await expect(runtime.connectRelay({ instanceId: "inst_not_running" })).rejects.toThrow(
        "is not running",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
