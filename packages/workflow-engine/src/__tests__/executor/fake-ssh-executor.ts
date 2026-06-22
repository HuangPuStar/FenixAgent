/**
 * Fake SSH 执行器 — 按正则匹配命令并返回预设响应。
 * 用于 SlurmNode 单元测试，无需真实 SSH 连接。
 *
 * 支持两种匹配模式：
 * - mockCommand(): 静态匹配，每次命中同一 pattern 返回同一响应
 * - mockCommandSequence(): 顺序匹配，同一 pattern 按注册顺序依次消费
 */

import type { SshExecutor } from "../../plugins/slurm-types";

interface MockResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type ResponseFactory = MockResponse | ((command: string) => MockResponse);

interface StaticEntry {
  pattern: RegExp;
  response: ResponseFactory;
}

interface QueuedEntry {
  pattern: RegExp;
  responses: ResponseFactory[];
  index: number;
}

export class FakeSshExecutor implements SshExecutor {
  private staticResponses: StaticEntry[] = [];
  private queuedResponses: QueuedEntry[] = [];

  /** 静态预设：每次匹配到同一 pattern 都返回相同响应 */
  mockCommand(pattern: RegExp, response: ResponseFactory): void {
    this.staticResponses.push({ pattern, response });
  }

  /**
   * 顺序预设：同一 pattern 注册 N 个响应，按调用顺序依次消费。
   * 用于模拟同一命令在不同调用返回不同结果的场景（如重试）。
   */
  mockCommandSequence(pattern: RegExp, responses: ResponseFactory[]): void {
    this.queuedResponses.push({ pattern, responses, index: 0 });
  }

  /** 清空所有预设 */
  reset(): void {
    this.staticResponses = [];
    this.queuedResponses = [];
  }

  /** 检查是否还有未消费的 queued 响应 */
  get pendingQueuedCalls(): number {
    return this.queuedResponses.reduce((sum, e) => sum + (e.responses.length - e.index), 0);
  }

  /** 是否为未被 mock 的 SSH 调用生成兜底空响应（静默模式），而不是抛错 */
  silentFallback = false;

  async exec(
    _host: string,
    command: string,
    _opts?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // 1. 先检查 queued 响应（顺序消费）
    for (const entry of this.queuedResponses) {
      if (entry.pattern.test(command) && entry.index < entry.responses.length) {
        const response = entry.responses[entry.index++];
        return typeof response === "function" ? response(command) : response;
      }
    }

    // 2. 再检查静态响应
    for (const { pattern, response } of this.staticResponses) {
      if (pattern.test(command)) {
        return typeof response === "function" ? response(command) : response;
      }
    }

    if (this.silentFallback) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    throw new Error(`Unmocked SSH command: ${command}`);
  }
}
