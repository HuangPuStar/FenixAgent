import assert from "node:assert/strict";
import * as z from "zod/v4";
import { TemporaryE2eAcp } from "./acp";
import { TemporaryE2eHttp, type TemporaryE2eHttpConfig } from "./http";

/** A 使用 ACP、B 使用 OpenAI；每轮同时发起，两轮复用各自会话。 */
export async function testConcurrentConversations(
  config: TemporaryE2eHttpConfig & { signal: AbortSignal; agentId: string },
  relayUrl: string,
  openaiInstanceId: string,
): Promise<void> {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([config.signal, cancellation.signal]);
  const http = new TemporaryE2eHttp({ ...config, signal });
  const acp = new TemporaryE2eAcp({ ...config, signal, relayUrl }, (value) => http.log(value));
  const a = `E2E_A_${crypto.randomUUID().replaceAll("-", "")}`;
  const b = `E2E_B_${crypto.randomUUID().replaceAll("-", "")}`;
  let handle: string | null = null;
  const prompt = (round: number, marker: string) =>
    round === 1
      ? `本会话的会话校验码：${marker}。请记住它，并只回复这个码。不调用工具，不操作文件。`
      : "只回复第一轮给你的会话校验码，不附加说明。不调用工具，不操作文件。";
  const check = (text: string, own: string, other: string) => {
    assert.ok(text.includes(own), "回复必须包含本会话第一轮的校验码，证明上下文保留");
    assert.ok(!text.includes(other), "不同实例的会话上下文不得串线");
  };
  const openai = async (round: number) => {
    const response = await http.request("POST", "/chat/completions", {
      headers: { "X-Instance-Id": openaiInstanceId, ...(handle ? { "X-Session-Id": handle } : {}) },
      json: { model: config.agentId, stream: false, messages: [{ role: "user", content: prompt(round, b) }] },
    });
    const result = z
      .object({
        choices: z
          .array(z.object({ message: z.object({ role: z.literal("assistant"), content: z.string().min(1) }) }))
          .min(1),
      })
      .parse(response.json);
    assert.equal(response.headers.get("x-instance-id"), openaiInstanceId);
    const returned = response.headers.get("x-session-id");
    assert.ok(returned, "OpenAI 第一轮必须返回可续聊的 X-Session-Id");
    if (handle) assert.ok(returned === handle, "OpenAI 第二轮必须保持同一续聊句柄");
    handle = returned;
    check(result.choices[0].message.content, b, a);
  };
  try {
    await acp.connect();
    for (const round of [1, 2]) {
      http.log(`\n[CONCURRENT] 第 ${round} 轮：A/ACP 与 B/OpenAI 同时发起`);
      const operations = [
        { label: "A/ACP", run: async () => check(await acp.prompt(prompt(round, a)), a, b) },
        { label: "B/OpenAI", run: async () => openai(round) },
      ];
      const results = await Promise.allSettled(
        operations.map(async (operation) => {
          try {
            await operation.run();
          } catch (error) {
            http.log(
              `[FAIL] 第 ${round} 轮 ${operation.label}：${error instanceof Error ? error.message : String(error)}`,
            );
            cancellation.abort(error);
            throw error;
          }
        }),
      );
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          `第 ${round} 轮并发会话失败`,
        );
      http.log(`[PASS] 第 ${round} 轮：A/ACP、B/OpenAI 会话校验均通过`);
    }
  } finally {
    acp.close();
  }
}
