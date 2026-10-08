import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFixture = promisify(execFile);

// bootstrap 使用进程级单例；独立进程验证无 Redis 选择，避免其他用例的测试替身污染。
test("无 Redis 的 bootstrap 重建保留会话标题", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/session-title-bootstrap.ts", import.meta.url));
  const { stderr } = await executeFixture(process.execPath, [fixture], { timeout: 10_000 });
  expect(stderr).toBe("");
}, 15_000);
