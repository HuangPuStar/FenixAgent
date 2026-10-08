import { describe, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const fixture = join(import.meta.dir, "fixtures", "algorithm-detail-copy.fixture.tsx");

/** Radix 在首次导入时捕获 DOM；独立进程同时隔离全量测试的模块缓存、替身与 Window。 */
async function runCopyScenario(scenario: "success" | "failure"): Promise<void> {
  await execute(process.execPath, [fixture, scenario], { timeout: 10_000, maxBuffer: 1024 * 1024 });
}

describe("算法详情弹窗复制", () => {
  // HTTP 假成功 polyfill 不能拦住真实弹窗 code 选择，复制完整内容后才提示成功。
  test("复制按钮写入完整代码后才提示成功", async () => {
    await runCopyScenario("success");
  }, 15_000);

  // 浏览器拒绝复制时保留原剪贴板，并在真实通知通道显示失败反馈。
  test("复制失败时不提示成功", async () => {
    await runCopyScenario("failure");
  }, 15_000);
});
