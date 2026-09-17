import { describe, expect, test } from "bun:test";
import { buildHealthInfo, buildInfo, resolveCommitId } from "../services/build-info";

describe("build info", () => {
  // 健康检查应返回构建版本和固定的服务启动时间。
  test("builds health info from the startup timestamp", () => {
    const startedAt = "2026-07-31T10:20:30.123Z";

    expect(buildHealthInfo(startedAt)).toEqual({
      status: "ok",
      commitId: buildInfo.commitId,
      startedAt,
    });
  });

  // 没有构建注入且 Git 不可用时应保持可用，并明确标记版本未知。
  test("falls back to unknown when no commit source is available", () => {
    expect(resolveCommitId(undefined, () => undefined)).toBe("unknown");
  });

  // 构建注入值应优先于本地 Git 状态。
  test("prefers the injected commit over the Git fallback", () => {
    expect(resolveCommitId("built-commit", () => "working-tree-commit")).toBe("built-commit");
  });

  // 本地调试启动时应读取一次当前 Git commit。
  test("uses the startup Git commit when no value is injected", () => {
    expect(resolveCommitId(undefined, () => "startup-commit")).toBe("startup-commit");
  });
});
