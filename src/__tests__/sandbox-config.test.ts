import { describe, expect, test } from "bun:test";
import type { SandboxResources } from "@fenix/sandbox-provider";
import { resolveSandboxConfig } from "../services/sandbox/sandbox-config";

const defaults: SandboxResources = {
  cpu: 2,
  memoryMb: 4096,
  diskGb: 20,
  gpuCount: 0,
  environment: { LANG: "C.UTF-8", DEFAULT: "yes" },
  volumes: [{ name: "workspace", target: "/workspace" }],
};

describe("sandbox config snapshot", () => {
  // 资源覆盖值只覆盖标量和环境变量，镜像来自 pool 默认配置。
  test("resolves image and resource overrides into a complete snapshot", () => {
    expect(
      resolveSandboxConfig("sandbox:v2", defaults, {
        cpu: 4,
        environment: { DEFAULT: "overridden", CUSTOM: "value" },
      }),
    ).toEqual({
      image: "sandbox:v2",
      providerExtra: {},
      resources: {
        ...defaults,
        cpu: 4,
        environment: { LANG: "C.UTF-8", DEFAULT: "overridden", CUSTOM: "value" },
      },
    });
  });

  // 显式传入 volumes 时整体替换默认挂载，避免隐式叠加宿主机路径。
  test("replaces volumes as a whole when overrides provide volumes", () => {
    expect(
      resolveSandboxConfig("sandbox:v1", defaults, {
        volumes: [{ name: "repo", target: "/repo", readOnly: true }],
      }).resources.volumes,
    ).toEqual([{ name: "repo", target: "/repo", readOnly: true }]);
  });

  // 没有资源覆盖时，快照必须完整复制 pool 的默认资源。
  test("copies defaults when overrides are absent", () => {
    expect(resolveSandboxConfig("sandbox:v1", defaults, null)).toEqual({
      image: "sandbox:v1",
      providerExtra: {},
      resources: defaults,
    });
  });

  // Provider 专属配置必须随资源池配置生成实例快照，避免后续修改 pool 影响存量实例。
  test("snapshots provider extra configuration", () => {
    expect(
      resolveSandboxConfig("sandbox:v1", defaults, null, {
        entrypoint: ["docker-entrypoint.sh", "acp-runtime", "opencode", "acp"],
      }),
    ).toEqual({
      image: "sandbox:v1",
      resources: defaults,
      providerExtra: {
        entrypoint: ["docker-entrypoint.sh", "acp-runtime", "opencode", "acp"],
      },
    });
  });

  // 资源快照中的宿主机逻辑路径必须以用户目录开头，确保沙盒重建后复用工作区。
  test("prefixes host volume sources with the stable user workspace", () => {
    const resolved = resolveSandboxConfig(
      "sandbox:image",
      {
        ...defaults,
        volumes: [{ name: "workspace", source: "ws", target: "/workspace" }],
      },
      { volumes: [{ name: "repo", source: "/repo", target: "/repo" }] },
      {},
      "user-123",
    );

    expect(resolved.resources.volumes).toEqual([{ name: "repo", source: "user-123/repo", target: "/repo" }]);
  });

  // 兼容调用方传入的三种逻辑路径写法，快照中统一保存为相对路径。
  test("normalizes logical volume path variants before prefixing the user", () => {
    const sources = ["ws", "/ws", "./ws"].map(
      (source) =>
        resolveSandboxConfig(
          "sandbox:image",
          defaults,
          { volumes: [{ name: "workspace", source, target: "/workspace" }] },
          {},
          "user-123",
        ).resources.volumes[0]?.source,
    );

    expect(sources).toEqual(["user-123/ws", "user-123/ws", "user-123/ws"]);
  });

  // 用户工作区路径不能逃逸到宿主机工作区外，也不能包含平台绝对路径或 NUL 字符。
  test("rejects unsafe user workspace volume paths", () => {
    for (const source of ["../other", "C:/absolute/path", "bad\0path"]) {
      expect(() =>
        resolveSandboxConfig(
          "sandbox:image",
          defaults,
          { volumes: [{ name: "workspace", source, target: "/workspace" }] },
          {},
          "user-123",
        ),
      ).toThrow();
    }
  });
});
