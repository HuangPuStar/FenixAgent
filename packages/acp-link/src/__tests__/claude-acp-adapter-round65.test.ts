import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as claudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAcpConnection } from "../client/claude-acp-adapter";

interface FakeQuery {
  streamInput(input: AsyncIterable<unknown>): Promise<void>;
  interrupt(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>>;
}

interface PromptOptions {
  cwd: string;
  canUseTool: (toolName: string, input: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
  continue?: boolean;
  resume?: string;
}

interface QueryCall {
  prompt: string;
  options: PromptOptions;
}

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "claude-adapter-round65-"));
  workspaces.push(path);
  return path;
}

function fakeQuery(messages: Array<Record<string, unknown>>): FakeQuery {
  return {
    async streamInput(_input) {},
    async interrupt() {},
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
  };
}

function updates(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null && "method" in message,
  );
}

afterEach(async () => {
  spyOn(claudeAgentSdk, "query").mockRestore();
  spyOn(claudeAgentSdk, "getSessionMessages").mockRestore();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Claude ACP adapter round65 SDK 内存分支", () => {
  // 首次提示必须隔离 SDK 工作目录、链接工作区配置，并将 SDK 会话标识持久化到目标会话。
  test("首次提示创建隔离目录并持久化 SDK 会话", async () => {
    const path = await workspace();
    await writeFile(join(path, "CLAUDE.md"), "安全约束");
    const calls: QueryCall[] = [];
    spyOn(claudeAgentSdk, "query").mockImplementation((request) => {
      calls.push(request as unknown as QueryCall);
      return fakeQuery([
        { type: "system", subtype: "init", session_id: "cc-first" },
        { type: "assistant", message: { content: [{ type: "text", text: "已完成" }] } },
      ]) as never;
    });

    const connection = createClaudeAcpConnection(path, "round65", () => {});
    const session = await connection.newSession({});
    const result = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "  检查发布配置  " }],
    });

    const sessionDir = join(path, ".cc-sessions", session.sessionId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ prompt: "  检查发布配置  ", options: { cwd: sessionDir } });
    expect(await readlink(join(sessionDir, "CLAUDE.md"))).toBe(join(path, "CLAUDE.md"));
    expect(result).toMatchObject({ stopReason: "end_turn", content: [{ type: "text", text: "已完成" }] });
    expect((await connection.listSessions({})).sessions[0]).toMatchObject({ title: "检查发布配置" });
  });

  // 当前 prompt 的 SDK 根用户回显必须被抑制，但 replay、异步来源和工具结果仍需进入时间线。
  test("仅抑制当前提示回显并保留合法 SDK 用户消息", async () => {
    const path = await workspace();
    const sent: unknown[] = [];
    const promptText = "检查消息归属";
    spyOn(claudeAgentSdk, "query").mockImplementation(() => {
      const userMessage = (extra: Record<string, unknown> = {}) => ({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: promptText }] },
        parent_tool_use_id: null,
        ...extra,
      });
      return fakeQuery([
        userMessage(),
        userMessage({ isReplay: true, uuid: "replay-1", session_id: "cc-replay" }),
        userMessage({ origin: { kind: "channel", server: "inbox" } }),
        userMessage({ origin: { kind: "peer", from: "peer-1" } }),
        userMessage({ origin: { kind: "task-notification" } }),
        userMessage({ origin: { kind: "coordinator" } }),
        userMessage({
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "done" },
              { type: "text", text: promptText },
            ],
          },
          tool_use_result: { status: "completed" },
        }),
        userMessage({
          message: {
            role: "user",
            content: [
              { type: "image", source: "opaque" },
              { type: "text", text: promptText },
            ],
          },
        }),
        userMessage({ origin: { kind: "human" } }),
        userMessage({ message: { role: "user", content: [{ type: "text", text: "异步补充" }] } }),
      ]) as never;
    });

    const connection = createClaudeAcpConnection(path, "round65", (message) => sent.push(message));
    const session = await connection.newSession({});
    await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: promptText }] });

    const userTexts = updates(sent)
      .map((message) => (message.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update)
      .filter((update) => update?.sessionUpdate === "user_message_chunk")
      .map((update) => update?.content?.text);
    expect(userTexts).toEqual([...Array.from({ length: 7 }, () => promptText), "异步补充"]);
  });

  // 前端批准一次工具调用后，适配器应解析挂起权限请求并将本会话切换为自动批准。
  test("权限控制响应解析工具请求并启用同会话自动批准", async () => {
    const path = await workspace();
    const sent: unknown[] = [];
    let call: QueryCall | undefined;
    spyOn(claudeAgentSdk, "query").mockImplementation((request) => {
      call = request as unknown as QueryCall;
      return fakeQuery([]) as never;
    });

    const connection = createClaudeAcpConnection(path, "round65", (message) => sent.push(message));
    const session = await connection.newSession({});
    await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "执行检查" }] });

    const permission = call?.options.canUseTool("Write", { file_path: "/tmp/safe.txt" }, { tool_use_id: "tool-1" });
    const request = sent[0] as { payload: { requestId: string } };
    expect(request).toMatchObject({
      type: "permission_request",
      payload: { sessionId: session.sessionId, toolName: "Write" },
    });
    (
      connection as unknown as {
        handleControlResponse(id: string, approved: boolean, extra?: Record<string, unknown>): void;
      }
    ).handleControlResponse(request.payload.requestId, true, { outcome: { optionId: "allow_always" } });
    await expect(permission).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: "/tmp/safe.txt" },
    });

    await expect(call?.options.canUseTool("Read", {}, { tool_use_id: "tool-2" })).resolves.toMatchObject({
      behavior: "allow",
    });
    expect(sent).toHaveLength(1);
  });

  // 恢复带 SDK 标识的会话时，应仅回放可展示的文本与工具块，并在后续提示中使用 resume。
  test("恢复会话回放历史并让后续提示使用 resume", async () => {
    const path = await workspace();
    const sent: unknown[] = [];
    const queryCalls: QueryCall[] = [];
    const historySpy = spyOn(claudeAgentSdk, "getSessionMessages").mockResolvedValue([
      { type: "user", message: { content: [{ type: "text", text: "历史问题" }, { type: "image" }] } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "历史回答" },
            {
              type: "tool_use",
              id: "todo-history",
              name: "TodoWrite",
              input: { todos: [{ content: "恢复计划", status: "in_progress" }] },
            },
            { type: "tool_use", id: "t1", name: "Read" },
          ],
        },
      },
    ] as never);
    spyOn(claudeAgentSdk, "query").mockImplementation((request) => {
      queryCalls.push(request as unknown as QueryCall);
      return fakeQuery([]) as never;
    });
    const metadataDir = join(path, ".claude", "acp-sessions");
    await mkdir(metadataDir, { recursive: true });
    await writeFile(
      join(metadataDir, "restored.json"),
      JSON.stringify({ sessionId: "restored", cwd: path, createdAt: 1, title: "恢复", ccSessionId: "cc-restored" }),
    );

    const connection = createClaudeAcpConnection(path, "round65", (message) => sent.push(message));
    const resumed = await connection.unstable_resumeSession({ sessionId: "restored" });
    const result = await connection.prompt({ sessionId: "restored", prompt: [{ type: "text", text: "继续" }] });

    expect(resumed.sessionId).toBe("restored");
    expect(historySpy).toHaveBeenCalledWith("cc-restored", { dir: path });
    const sessionUpdates = updates(sent).map((message) => {
      const params = message.params as { update: { sessionUpdate: string; content: Record<string, unknown> } };
      return params.update;
    });
    expect(sessionUpdates).toContainEqual({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "历史问题" },
    });
    expect(sessionUpdates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "历史回答" },
    });
    expect(sessionUpdates).toContainEqual({
      sessionUpdate: "plan",
      entries: [{ content: "恢复计划", priority: "medium", status: "in_progress" }],
    });
    expect(sessionUpdates).toContainEqual(
      expect.objectContaining({ sessionUpdate: "tool_call", content: expect.objectContaining({ type: "tool_use" }) }),
    );
    expect(
      sessionUpdates.some(
        (update) =>
          update.sessionUpdate === "tool_call" && (update.content as Record<string, unknown>)?.name === "TodoWrite",
      ),
    ).toBe(false);
    expect(queryCalls[0]).toMatchObject({ prompt: "继续", options: { resume: "cc-restored" } });
    expect(result).toEqual({ stopReason: "end_turn", content: [] });
  });
});
