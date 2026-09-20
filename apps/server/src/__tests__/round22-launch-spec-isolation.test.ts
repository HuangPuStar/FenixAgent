import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { composeAgentSystemPrompt } from "@fenix/agent-config/server/system-prompt";
import { resolveApiKey } from "../services/config-utils";

/**
 * 宿主侧的启动规格边界与输入边界。
 *
 * 「启动规格」这一半在本文件里只剩**反向断言**：启动参数组装（`AgentLaunchSpec`）自任务 1.4 W4b 起
 * 完全由 `@fenix/agent-config` 拥有、经 `AgentLaunchSpecPort` 注入，宿主不再持有 `buildLaunchSpec`。
 * 组装规则本身由 agent-config 的 `agent-launch-spec-*.test.ts` 逐条覆盖，这里只守住「宿主不再有第二份
 * 实现入口」——同一份规格出现两个入口时，只有其中一个会跟着改动走。
 *
 * 「输入边界」这一半只剩宿主仍要负责的两项：`{env:...}` 密钥解引用（资源包不得读宿主环境变量）与系统
 * 提示词拼装。资源名校验、控制台响应包装、JSON 安全转换、密钥提示四项随宿主 `services/config-utils.ts`
 * 的信封函数在任务 1.5c 删除：它们的消费方是已迁入资源包的旧路由，宿主副本零生产消费方，行为由包内
 * 实现（`@fenix/model-management` 的 `config-envelope.ts`、`@fenix/agent-config` 的 `isValidAgentName`）
 * 的用例覆盖。
 */

describe("round22 宿主启动规格边界与输入边界", () => {
  beforeEach(() => delete process.env.ROUND22_PROVIDER_KEY);
  afterEach(() => delete process.env.ROUND22_PROVIDER_KEY);

  // 宿主不再从 agent-runtime 取启动参数组装入口：该实现在 W4b 随旧 builder 一并删除，重新导出等于
  // 复活一条绕过端口（以及绕过 agent-config 可见性判定）的取数路径。
  test("agent-runtime 入口不再导出启动参数组装", async () => {
    const runtime: Record<string, unknown> = await import("@fenix/agent-runtime/server");

    expect(runtime.buildLaunchSpec).toBeUndefined();
    expect(runtime.buildBasicLaunchSpec).toBeUndefined();
  });

  // 密钥解析只识别完整 env 引用，避免错误输入被提升为凭据。
  test.each([
    ["空值", undefined, undefined, null],
    ["null", null, undefined, null],
    ["明文", "local-key", undefined, "local-key"],
    ["已配置 env", "{env:ROUND22_KEY}", "resolved", "resolved"],
    ["缺失 env", "{env:ROUND22_MISSING}", undefined, null],
    ["非完整引用", "x{env:ROUND22_KEY}", "resolved", "x{env:ROUND22_KEY}"],
    ["空名称", "{env:}", "resolved", "{env:}"],
  ])("密钥解析%s", (_label, raw, value, expected) => {
    if (value) process.env.ROUND22_KEY = value;
    expect(resolveApiKey(raw)).toBe(expected);
    delete process.env.ROUND22_KEY;
  });

  // 系统提示词必须替换占位符，并在缺少插槽时安全追加用户要求。
  test.each([
    ["完整模板", "名称={{agentName}} 内容={{userPrompt}}", "隔离助手", " 审计 ", "名称=隔离助手 内容=审计"],
    ["追加用户提示", "名称={{agentName}}", "隔离助手", "审计", "名称=隔离助手\n\n## User Prompt\n审计"],
    ["空用户提示", "名称={{agentName}}", "隔离助手", "  ", "名称=隔离助手"],
    ["无用户提示", "固定规则", "隔离助手", undefined, "固定规则"],
    ["重复名称", "{{agentName}}/{{agentName}}", "隔离助手", undefined, "隔离助手/隔离助手"],
    ["裁剪完整模板", "  {{userPrompt}}  ", "隔离助手", " 内容 ", "内容"],
  ])("系统提示词%s", (_label, template, name, prompt, expected) =>
    expect(composeAgentSystemPrompt(template, name, prompt)).toBe(expected));
});
