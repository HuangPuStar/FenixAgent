import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PythonExecutor } from "../../executor/python-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { NodeDef, PythonNodeDef } from "../../types/dag";
import { WorkflowErrorCode } from "../../types/errors";

interface FakeSubprocess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
}

function createStream(content = ""): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (content) controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

function createHangingSubprocess(kills: string[]): FakeSubprocess {
  let resolveExit: (exitCode: number) => void = () => {};
  let closeStdout: () => void = () => {};
  let closeStderr: () => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStdout = () => controller.close();
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStderr = () => controller.close();
    },
  });

  return {
    pid: 4321,
    stdout,
    stderr,
    exited,
    kill(signal) {
      kills.push(signal ?? "");
      closeStdout();
      closeStderr();
      resolveExit(137);
    },
  };
}

function createSubprocess(stdout = "", stderr = "", exitCode = 0): FakeSubprocess {
  return {
    pid: 1234,
    stdout: createStream(stdout),
    stderr: createStream(stderr),
    exited: Promise.resolve(exitCode),
    kill() {},
  };
}

function makeContext(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    runId: "python-executor-fake-run",
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: new AbortController().signal,
    storage: createInMemoryStorage(),
    ...overrides,
  };
}

function makeNode(overrides: Partial<PythonNodeDef> = {}): PythonNodeDef {
  return {
    id: "python-fake-node",
    type: "python",
    code: 'print("default")',
    ...overrides,
  };
}

describe("PythonExecutor 内存 fake 分支", () => {
  const writeSpy = spyOn(Bun, "write");
  const spawnSpy = spyOn(Bun, "spawn");

  afterEach(() => {
    writeSpy.mockReset();
    spawnSpy.mockReset();
  });

  test("非 Python 节点在写入脚本前返回 NODE_FAILED", async () => {
    const executor = new PythonExecutor();
    const node: NodeDef = { id: "shell-node", type: "shell", command: "echo ignored" };

    await expect(executor.execute(node, makeContext())).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
    });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test("解析后的代码、环境与工作目录用于组装 python3 命令", async () => {
    const executor = new PythonExecutor();
    const ctx = makeContext({
      secrets: { CONTEXT_VALUE: "from-context" },
      resolvedInputs: {
        code: "print(message)",
        cwd: "/memory/workflow",
        env: { NODE_VALUE: "from-node" },
        inputs: { message: { value: "已注入", rawExpression: "params.message" } },
      },
    });
    writeSpy.mockResolvedValue(0);
    spawnSpy.mockImplementation(() => createSubprocess("ok\n") as unknown as ReturnType<typeof Bun.spawn>);

    const output = await executor.execute(makeNode({ code: "print('unused')" }), ctx);

    expect(output).toMatchObject({ stdout: "ok\n", exit_code: 0 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]?.[1]).toContain('message = "已注入"');
    expect(writeSpy.mock.calls[0]?.[1]).toContain("print(message)");
    expect(spawnSpy).toHaveBeenCalledWith(
      ["python3", expect.stringMatching(/^.*wf-python-.*\.py$/)],
      expect.objectContaining({
        cwd: "/memory/workflow",
        env: expect.objectContaining({ CONTEXT_VALUE: "from-context", NODE_VALUE: "from-node" }),
      }),
    );
  });

  test("pip 安装失败时返回截断后的 NODE_FAILED 且不启动 python3", async () => {
    const executor = new PythonExecutor();
    writeSpy.mockResolvedValue(0);
    spawnSpy.mockImplementation(
      () => createSubprocess("", "dependency missing", 2) as unknown as ReturnType<typeof Bun.spawn>,
    );

    await expect(
      executor.execute(makeNode({ requirements: ["missing-package"] }), makeContext()),
    ).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
      message: expect.stringContaining("pip install failed (exit 2): dependency missing"),
    });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(
      ["pip", "install", "--quiet", "missing-package"],
      expect.objectContaining({ stdout: "pipe", stderr: "pipe" }),
    );
  });

  test("Python 非零退出码记录失败事件并保留 stdout 与 stderr 摘要", async () => {
    const executor = new PythonExecutor();
    const ctx = makeContext();
    writeSpy.mockResolvedValue(0);
    spawnSpy.mockImplementation(
      () => createSubprocess("partial output", "traceback detail", 7) as unknown as ReturnType<typeof Bun.spawn>,
    );

    await expect(executor.execute(makeNode(), ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
      message: "Python exited with code 7: traceback detail",
    });

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "python-fake-node" });
    expect(events.find((event) => event.type === "node.failed")?.metadata).toMatchObject({
      exit_code: 7,
      stdout: "partial output",
      stderr: "traceback detail",
    });
  });

  test("节点超时时终止内存子进程并返回 NODE_TIMEOUT", async () => {
    const executor = new PythonExecutor();
    const kills: string[] = [];
    writeSpy.mockResolvedValue(0);
    spawnSpy.mockImplementation(() => createHangingSubprocess(kills) as unknown as ReturnType<typeof Bun.spawn>);

    await expect(executor.execute(makeNode({ timeout: 0 }), makeContext())).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_TIMEOUT,
    });
    expect(kills).toEqual(["SIGKILL"]);
  });
});
