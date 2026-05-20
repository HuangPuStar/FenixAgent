/**
 * ProcessExecutor + NodeExecutorRegistry 测试
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { ProcessExecutor } from '../../executor/process-executor';
import { NodeExecutorRegistry, createNodeExecutorRegistry } from '../../executor/node-executor';
import type { ShellNodeDef } from '../../types/dag';
import type { NodeExecutor, NodeExecutionContext } from '../../scheduler/dag-scheduler';
import { createInMemoryStorage } from '../../storage/in-memory-storage';
import { WorkflowError, WorkflowErrorCode } from '../../types/errors';

// ---------- 辅助工具 ----------

/** 创建测试用的 NodeExecutionContext */
function makeCtx(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const storage = createInMemoryStorage();
  return {
    runId: 'test-run-001',
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: AbortSignal.timeout(30_000),
    storage,
    ...overrides,
  };
}

/** 创建简单的 shell 节点定义 */
function shellNode(command: string, overrides?: Partial<ShellNodeDef>): ShellNodeDef {
  return {
    id: 'test-node',
    type: 'shell',
    command,
    ...overrides,
  };
}

// ========== ProcessExecutor 测试 ==========

describe('ProcessExecutor', () => {
  let executor: ProcessExecutor;

  beforeEach(() => {
    executor = new ProcessExecutor();
  });

  // echo "hello" → 正确输出
  test('echo 命令返回正确 stdout 和 exit_code 0', async () => {
    const ctx = makeCtx();
    const node = shellNode('echo "hello"');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('hello\n');
    expect(output.size).toBeGreaterThan(0);
  });

  // exit 1 → WorkflowError
  test('非零退出码抛出 WorkflowError', async () => {
    const ctx = makeCtx();
    const node = shellNode('exit 1');

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
    await expect(executor.execute(node, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
    });
  });

  // node.failed 事件
  test('非零退出码产生 node.failed 事件', async () => {
    const ctx = makeCtx();
    const node = shellNode('exit 42');

    try {
      await executor.execute(node, ctx);
    } catch {}

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: 'test-node' });
    const failedEvents = events.filter((e) => e.type === 'node.failed');
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].metadata?.exit_code).toBe(42);
  });

  // node.started 事件
  test('执行产生 node.started 事件', async () => {
    const ctx = makeCtx();
    const node = shellNode('echo ok');
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: 'test-node' });
    const startedEvents = events.filter((e) => e.type === 'node.started');
    expect(startedEvents.length).toBe(1);
    expect(startedEvents[0].metadata?.pid).toBeGreaterThan(0);
  });

  // node.completed 事件
  test('成功执行产生 node.completed 事件', async () => {
    const ctx = makeCtx();
    const node = shellNode('echo done');
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: 'test-node' });
    const completedEvents = events.filter((e) => e.type === 'node.completed');
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].metadata?.exit_code).toBe(0);
  });

  // inputs 注入 params 为环境变量
  test('inputs 注入 params 为环境变量', async () => {
    const ctx = makeCtx({
      params: { input: 'world' },
      resolvedInputs: {
        command: 'echo "hello $input"',
        inputs: { input: { value: 'world', rawExpression: 'params.input' } },
      },
    });
    const node = shellNode('echo "hello $input"', {
      inputs: { input: 'params.input' },
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('hello world\n');
  });

  // inputs 注入 secrets 为环境变量
  test('inputs 注入 secrets 为环境变量', async () => {
    const ctx = makeCtx({
      secrets: { MY_SECRET: 's3cret' },
      resolvedInputs: {
        command: 'echo "$MY_SECRET"',
        inputs: { MY_SECRET: { value: 's3cret', rawExpression: 'secrets.MY_SECRET' } },
      },
    });
    const node = shellNode('echo "$MY_SECRET"', {
      inputs: { MY_SECRET: 'secrets.MY_SECRET' },
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('s3cret\n');
  });

  // 环境变量注入
  test('node.env 注入为子进程环境变量', async () => {
    const ctx = makeCtx();
    const node = shellNode('echo "$MY_VAR"', {
      env: { MY_VAR: 'from_node_env' },
    });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe('from_node_env');
  });

  // secrets 注入为环境变量
  test('secrets 注入为子进程环境变量', async () => {
    const ctx = makeCtx({ secrets: { API_KEY: 'key123' } });
    const node = shellNode('echo "$API_KEY"');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe('key123');
  });

  // stdout JSON 解析
  test('stdout 为合法 JSON 时 json 字段被解析', async () => {
    const ctx = makeCtx();
    const node = shellNode("echo '{\"key\":\"value\"}'");
    const output = await executor.execute(node, ctx);

    expect(output.json).toEqual({ key: 'value' });
  });

  // stdout 非法 JSON 时 json 为 undefined
  test('stdout 非法 JSON 时 json 为 undefined', async () => {
    const ctx = makeCtx();
    const node = shellNode('echo not-json');
    const output = await executor.execute(node, ctx);

    expect(output.json).toBeUndefined();
  });

  // 超时
  test('超时后节点失败', async () => {
    const ctx = makeCtx();
    const node = shellNode('sleep 10', { timeout: 1 });
    const start = Date.now();

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
    await expect(executor.execute(node, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_TIMEOUT,
    });

    const elapsed = Date.now() - start;
    // 超时应该在 1 秒左右触发，给 3 秒余量
    expect(elapsed).toBeLessThan(3000);
  });

  // 外部取消
  test('外部 AbortSignal 取消后节点失败', async () => {
    const controller = new AbortController();
    const ctx = makeCtx({ signal: controller.signal });
    const node = shellNode('sleep 10');

    // 100ms 后取消
    setTimeout(() => controller.abort(), 100);

    let caughtError: WorkflowError | null = null;
    try {
      await executor.execute(node, ctx);
    } catch (e) {
      caughtError = e as WorkflowError;
    }

    expect(caughtError).toBeInstanceOf(WorkflowError);
    expect(caughtError?.code).toBe(WorkflowErrorCode.DAG_CANCELLED);
  });

  // 非法节点类型
  test('非 shell 节点抛出错误', async () => {
    const ctx = makeCtx();
    const node = { id: 'bad', type: 'agent' } as any;

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });
});

// ========== 重试测试 ==========

describe('ProcessExecutor retry', () => {
  let executor: ProcessExecutor;
  const tempFiles: string[] = [];

  beforeEach(() => {
    executor = new ProcessExecutor();
  });

  afterEach(async () => {
    // 清理临时文件
    for (const f of tempFiles) {
      try {
        await Bun.file(f).exists() && require('fs').unlinkSync(f);
      } catch {}
    }
    tempFiles.length = 0;
  });

  // 重试：第一次失败，第二次成功
  test('重试机制：第一次失败、第二次成功 → COMPLETED', async () => {
    const markerFile = `/tmp/_wf_test_retry_${process.pid}_${Date.now()}`;
    tempFiles.push(markerFile);

    // 第一次执行创建标记文件并 exit 1，第二次检测到文件后 echo ok
    const command = `if [ -f ${markerFile} ]; then echo ok; rm ${markerFile}; else touch ${markerFile}; exit 1; fi`;

    const ctx = makeCtx();
    const node = shellNode(command, {
      retry: { count: 1, delay: 100, backoff: 'fixed' },
    });

    const output = await executor.execute(node, ctx);
    expect(output.exit_code).toBe(0);
    expect(output.stdout.trim()).toBe('ok');

    // 验证事件：应该有 node.started, node.failed（第一次）, node.retrying, node.started, node.completed
    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: 'test-node' });
    const retryEvents = events.filter((e) => e.type === 'node.retrying');
    expect(retryEvents.length).toBe(1);
    expect(retryEvents[0].metadata?.attempt).toBe(2);
    expect(retryEvents[0].metadata?.max_attempts).toBe(2);
  });

  // 重试耗尽仍失败
  test('重试耗尽后仍然失败', async () => {
    const ctx = makeCtx();
    const node = shellNode('exit 1', {
      retry: { count: 2, delay: 50, backoff: 'fixed' },
    });

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: 'test-node' });
    const retryEvents = events.filter((e) => e.type === 'node.retrying');
    expect(retryEvents.length).toBe(2); // 2 次重试
  });

  // 指数退避
  test('指数退避模式重试', async () => {
    const markerFile = `/tmp/_wf_test_exp_backoff_${process.pid}_${Date.now()}`;
    tempFiles.push(markerFile);

    const command = `if [ -f ${markerFile} ]; then echo ok; rm ${markerFile}; else touch ${markerFile}; exit 1; fi`;

    const ctx = makeCtx();
    const node = shellNode(command, {
      retry: { count: 2, delay: 100, backoff: 'exponential' },
    });

    const start = Date.now();
    const output = await executor.execute(node, ctx);
    const elapsed = Date.now() - start;

    expect(output.exit_code).toBe(0);
    // 指数退避：100 * 2^0 * jitter ≈ 100ms，应该在 500ms 内完成
    expect(elapsed).toBeLessThan(500);
  });
});

// ========== stderr 测试 ==========

describe('ProcessExecutor stderr', () => {
  test('stderr 不影响正常输出', async () => {
    const executor = new ProcessExecutor();
    const ctx = makeCtx();
    // 同时写 stdout 和 stderr
    const node = shellNode('echo stdout_msg; echo stderr_msg >&2');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('stdout_msg\n');
  });
});

// ========== NodeExecutorRegistry 测试 ==========

describe('NodeExecutorRegistry', () => {
  test('注册并执行对应类型的执行器', async () => {
    const registry = createNodeExecutorRegistry();
    const ctx = makeCtx();

    const mockExecutor: NodeExecutor = {
      async execute(node) {
        return { stdout: `mock-${node.id}`, exit_code: 0 };
      },
    };

    registry.register('shell', mockExecutor);

    const node = shellNode('echo test');
    const output = await registry.execute(node, ctx);

    expect(output.stdout).toBe('mock-test-node');
  });

  test('未注册类型抛出 WorkflowError', async () => {
    const registry = createNodeExecutorRegistry();
    const ctx = makeCtx();
    const node = shellNode('echo test');

    await expect(registry.execute(node, ctx)).rejects.toThrow(WorkflowError);
    await expect(registry.execute(node, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
    });
  });

  test('注册多种类型分别分发', async () => {
    const registry = createNodeExecutorRegistry();
    const ctx = makeCtx();

    const shellExec: NodeExecutor = {
      async execute() {
        return { stdout: 'shell-output', exit_code: 0 };
      },
    };
    const apiExec: NodeExecutor = {
      async execute() {
        return { stdout: 'api-output', exit_code: 0 };
      },
    };

    registry.register('shell', shellExec);
    registry.register('api', apiExec);

    const shellNode_ = { id: 's1', type: 'shell' as const, command: 'echo hi' };
    const apiNode = { id: 'a1', type: 'api' as const, url: 'http://example.com' };

    const shellOutput = await registry.execute(shellNode_, ctx);
    expect(shellOutput.stdout).toBe('shell-output');

    const apiOutput = await registry.execute(apiNode, ctx);
    expect(apiOutput.stdout).toBe('api-output');
  });
});
