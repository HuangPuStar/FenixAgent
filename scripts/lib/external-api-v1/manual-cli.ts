import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { type ConnectionConfig, ManualRunner } from "./runner";

/** 三个独立入口共用交互和日志行为，各自选择配置及执行流程。 */
interface ManualScenario<Config extends ConnectionConfig> {
  configName: "AGENT_CONFIG" | "WORKFLOW_CONFIG" | "WORKFLOW_V2_CONFIG";
  description: string;
  operations: readonly string[];
  extraCoverage?: string;
  validate: (config: Config) => void;
  run: (config: Config, runner: ManualRunner, resources: Record<string, string>) => Promise<void>;
  secrets?: (config: Config) => string[];
}

/** 默认连续执行；传入 -t 后每次请求或聊天等待回车。 */
async function main<Config extends ConnectionConfig>(scenario: ManualScenario<Config>): Promise<void> {
  if (process.argv.includes("--list")) {
    console.log(
      `${scenario.operations.length} 项 HTTP 接口${scenario.extraCoverage ?? ""}：\n${scenario.operations.join("\n")}`,
    );
    return;
  }
  const configUrl = new URL("../../test-external-api-v1.config.local.ts", import.meta.url);
  if (!(await Bun.file(configUrl).exists()))
    throw new Error(
      "缺少本地配置，请先执行：cp scripts/test-external-api-v1.config.example.ts scripts/test-external-api-v1.config.local.ts",
    );
  const configs = (await import(configUrl.href)) as Record<string, Config>;
  const CONFIG = configs[scenario.configName];
  assert.ok(CONFIG, `本地配置文件缺少导出的 ${scenario.configName}，请参考 example 文件`);
  scenario.validate(CONFIG);
  const interactive = process.argv.includes("-t");
  if (interactive && !process.stdin.isTTY) throw new Error("-t 模式请在交互式终端运行，按回车继续测试。");
  const terminal = interactive
    ? createInterface({ input: process.stdin, output: process.stdout, terminal: false })
    : undefined;
  const resources: Record<string, string> = {};
  const runner = new ManualRunner(
    { ...CONFIG, secrets: [...(CONFIG.secrets ?? []), ...(scenario.secrets?.(CONFIG) ?? [])] },
    {
      write: (line) => console.log(line),
      pause: async () => {
        if (!terminal) return;
        await new Promise<void>((resolve) => {
          terminal.question("\u001b[36m观察页面后按回车继续（Ctrl+C 结束）> \u001b[0m", () => resolve());
        });
      },
    },
  );
  const interrupted = () => {
    runner.print("已停止，资源线索", resources);
    terminal?.close();
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    console.log(
      `开始测试 ${scenario.description}；${interactive ? "每个接口和每轮聊天后暂停，按回车继续。" : "连续执行，不暂停。"}`,
    );
    await scenario.run(CONFIG, runner, resources);
  } catch (error) {
    runner.print("测试终止", error instanceof Error ? error.message : String(error));
    runner.print("本轮资源（未自动清理）", resources);
    runner.print("已通过接口", [...runner.operations]);
    process.exitCode = 1;
  } finally {
    terminal?.close();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
}

/** 执行独立手工测试并统一报告启动错误。 */
export async function runManualScenario<Config extends ConnectionConfig>(
  scenario: ManualScenario<Config>,
): Promise<void> {
  try {
    await main(scenario);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
