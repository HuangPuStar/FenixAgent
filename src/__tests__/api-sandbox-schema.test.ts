import { describe, expect, test } from "bun:test";
import { SandboxInstanceUpdateBodySchema } from "../schemas/api-sandbox.schema";

describe("sandbox instance update schema", () => {
  // 管理面资源更新只允许四项资源参数，避免覆盖沙盒工作空间和连接环境变量。
  test("rejects environment and volumes in resource overrides", () => {
    const result = SandboxInstanceUpdateBodySchema.safeParse({
      resourceOverrides: {
        cpu: 2,
        environment: { RCS_MACHINE_ID: "should-not-change" },
        volumes: [{ name: "workspace", target: "/workspace" }],
      },
    });

    expect(result.success).toBe(false);
  });
});
