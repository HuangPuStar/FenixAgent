import { describe, expect, test } from "bun:test";
import { isSandboxCreateRequest, rewriteSandboxCreateBody } from "../services/sandbox-volume-rewriter";

describe("sandbox volume rewriter", () => {
  test("prefixes host paths and keeps container mount paths unchanged", () => {
    const result = rewriteSandboxCreateBody(
      {
        volumes: [
          { name: "workspace", host: { path: "ws" }, mountPath: "/workspace" },
          { name: "config", host: { path: "/config" }, mountPath: "/app/config" },
          { name: "managed", pvc: { claimName: "sbi-workspace" }, mountPath: "/data" },
        ],
      },
      "sbi_xxx",
      "/data/opensandbox/sandboxes",
    ) as { volumes: Array<{ name?: string; host?: { path: string }; mountPath?: string; pvc?: unknown }> };

    expect(result.volumes[0]).toEqual({
      name: "workspace",
      host: { path: "/data/opensandbox/sandboxes/sbi_xxx/ws" },
      mountPath: "/workspace",
    });
    expect(result.volumes[1].host?.path).toBe("/data/opensandbox/sandboxes/sbi_xxx/config");
    expect(result.volumes[2]).toEqual({
      name: "managed",
      pvc: { claimName: "sbi-workspace" },
      mountPath: "/data",
    });
  });

  test("normalizes relative path variants", () => {
    const paths = ["ws", "/ws", "./ws"].map((path) => {
      const body = rewriteSandboxCreateBody(
        { volumes: [{ host: { path } }] },
        "sbi_xxx",
        "/data/opensandbox/sandboxes",
      ) as {
        volumes: Array<{ host: { path: string } }>;
      };
      return body.volumes[0].host.path;
    });

    expect(paths).toEqual([
      "/data/opensandbox/sandboxes/sbi_xxx/ws",
      "/data/opensandbox/sandboxes/sbi_xxx/ws",
      "/data/opensandbox/sandboxes/sbi_xxx/ws",
    ]);
  });

  test("rejects paths that escape the sandbox workspace", () => {
    expect(() =>
      rewriteSandboxCreateBody({ volumes: [{ host: { path: "../other" } }] }, "sbi_xxx", "/data/opensandbox/sandboxes"),
    ).toThrow("escapes");
    expect(() =>
      rewriteSandboxCreateBody(
        { volumes: [{ host: { path: "ws/../../other" } }] },
        "sbi_xxx",
        "/data/opensandbox/sandboxes",
      ),
    ).toThrow("escapes");
  });

  test("only rewrites the lifecycle create endpoint", () => {
    expect(isSandboxCreateRequest("POST", "/v1/sandboxes")).toBe(true);
    expect(isSandboxCreateRequest("GET", "/v1/sandboxes")).toBe(false);
    expect(isSandboxCreateRequest("POST", "/v1/sandboxes/sbi_xxx")).toBe(false);
  });
});
