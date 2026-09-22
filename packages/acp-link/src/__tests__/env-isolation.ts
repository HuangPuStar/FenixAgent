import { afterAll } from "bun:test";

/**
 * 隔离宿主进程注入的 ANTHROPIC_MODEL。
 *
 * claude-acp-adapter 的默认模型优先级为「显式参数 > ANTHROPIC_MODEL > claude-sonnet-4-6」，
 * 而 Claude Code 等宿主会向子进程注入该变量。若不隔离，"未显式指定模型时应回落到内置默认值"
 * 一类断言会读到宿主取值而失败，使测试结果随开发机环境漂移（CI 无此变量，故表现为本地红、CI 绿）。
 *
 * 在测试文件顶层调用一次：清空当前进程取值，并在本文件全部测试结束后恢复宿主取值，避免污染
 * 同进程内运行的其它测试文件。需要验证 env 优先级的用例应在用例内自行设置并还原
 * （见 claude-acp-adapter-round64.test.ts）。
 */
export function isolateHostAnthropicModel(): void {
  const hostValue = process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  afterAll(() => {
    if (hostValue === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = hostValue;
  });
}
