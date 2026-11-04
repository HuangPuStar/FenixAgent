import { expect, test } from "bun:test";
import { EXTERNAL_V1_OPERATIONS } from "../../apps/server/src/test-utils/external-v1-operations";

// 三个入口各自列出完整覆盖范围，不混入其他类别的接口。
test.each([
  { file: "test-agent-api-v1.ts", operations: EXTERNAL_V1_OPERATIONS.filter((path) => !path.includes("/workflows/")) },
  { file: "test-workflow-api-v1.ts", operations: ["POST /api/v1/workflows/{workflowId}/execute"] },
  { file: "test-workflow-v2-api-v1.ts", operations: ["POST /api/v1/workflow-v2/workflows/{id}/run"] },
])("$file 独立列出接口", ({ file, operations }) => {
  const path = new URL(`../${file}`, import.meta.url).pathname;
  const result = Bun.spawnSync(["bun", path, "--list"], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  const listed = result.stdout
    .toString()
    .split("\n")
    .filter((line) => /^(GET|POST|PATCH|DELETE) /.test(line));
  expect(listed.sort()).toEqual(operations);
});
