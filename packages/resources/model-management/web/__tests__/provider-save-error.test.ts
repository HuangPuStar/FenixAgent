import { describe, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const fixture = join(import.meta.dir, "fixtures", "provider-save-error.fixture.tsx");

/** 隔离全包测试的 i18n 替身，验证真实保存控制器的错误反馈。 */
async function runScenario(scenario: "duplicate" | "generic"): Promise<void> {
  await execute(process.execPath, [fixture, scenario], { timeout: 10_000, maxBuffer: 1024 * 1024 });
}

describe("Provider 保存失败反馈", () => {
  // 同名创建失败时应显示用户提交的配置名称，避免提示中的名称为空或被展示名称替代。
  test("重名提示保留去空白后的配置名称", async () => {
    await runScenario("duplicate");
  });

  // 普通保存错误仍保留后端原因，不能被错误归类为名称冲突。
  test("普通失败保留诊断信息", async () => {
    await runScenario("generic");
  });
});
