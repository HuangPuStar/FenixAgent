/**
 * PythonExecutor 测试 — inputs 变量注入、重试、事件发射
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { PythonExecutor } from '../../executor/python-executor';
import type { PythonNodeDef } from '../../types/dag';
import type { NodeExecutionContext } from '../../scheduler/dag-scheduler';
import { createInMemoryStorage } from '../../storage/in-memory-storage';
import { WorkflowError, WorkflowErrorCode } from '../../types/errors';

// ---------- 辅助工具 ----------

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

function pyNode(code: string, overrides?: Partial<PythonNodeDef>): PythonNodeDef {
  return {
    id: 'test-py-node',
    type: 'python',
    code,
    ...overrides,
  };
}

// ========== 基础执行测试 ==========

describe('PythonExecutor', () => {
  let executor: PythonExecutor;

  beforeEach(() => {
    executor = new PythonExecutor();
  });

  // 简单 echo
  test('简单 print 返回正确 stdout 和 exit_code 0', async () => {
    const ctx = makeCtx();
    const node = pyNode('print("hello")');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('hello\n');
    expect(output.size).toBeGreaterThan(0);
  });

  // 非零退出码抛 WorkflowError
  test('非零退出码抛出 WorkflowError', async () => {
    const ctx = makeCtx();
    const node = pyNode('import sys; sys.exit(1)');

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // 非 python 节点抛出错误
  test('非 python 节点抛出错误', async () => {
    const ctx = makeCtx();
    const node = { id: 'bad', type: 'shell' } as any;

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // node.started 事件
  test('执行产生 node.started 事件', async () => {
    const ctx = makeCtx();
    const node = pyNode('print("ok")');
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: 'test-py-node' });
    const startedEvents = events.filter((e) => e.type === 'node.started');
    expect(startedEvents.length).toBe(1);
    expect(startedEvents[0].metadata?.pid).toBeGreaterThan(0);
  });

  // node.completed 事件
  test('成功执行产生 node.completed 事件', async () => {
    const ctx = makeCtx();
    const node = pyNode('print("done")');
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: 'test-py-node' });
    const completedEvents = events.filter((e) => e.type === 'node.completed');
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].metadata?.exit_code).toBe(0);
  });

  // node.failed 事件
  test('非零退出码产生 node.failed 事件', async () => {
    const ctx = makeCtx();
    const node = pyNode('import sys; sys.exit(42)');

    try {
      await executor.execute(node, ctx);
    } catch {}

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: 'test-py-node' });
    const failedEvents = events.filter((e) => e.type === 'node.failed');
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].metadata?.exit_code).toBe(42);
  });

  // stdout JSON 解析
  test('stdout 为合法 JSON 时 json 字段被解析', async () => {
    const ctx = makeCtx();
    const node = pyNode('import json; print(json.dumps({"key": "value"}))');
    const output = await executor.execute(node, ctx);

    expect(output.json).toEqual({ key: 'value' });
  });

  // stdout 非法 JSON 时 json 为 undefined
  test('stdout 非法 JSON 时 json 为 undefined', async () => {
    const ctx = makeCtx();
    const node = pyNode('print("not-json")');
    const output = await executor.execute(node, ctx);

    expect(output.json).toBeUndefined();
  });
});

// ========== inputs 变量注入测试 ==========

describe('PythonExecutor inputs 注入', () => {
  let executor: PythonExecutor;

  beforeEach(() => {
    executor = new PythonExecutor();
  });

  // 字符串 inputs 注入为 Python 变量
  test('字符串 inputs 注入为 Python 变量', async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: 'print(name)',
        inputs: { name: { value: 'world', rawExpression: 'params.name' } },
      },
    });
    const node = pyNode('print(name)', { inputs: { name: 'params.name' } });
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('world\n');
  });

  // 数字 inputs 注入
  test('数字 inputs 注入为 Python 数字', async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: 'print(count)',
        inputs: { count: { value: 42, rawExpression: 'nodes.fetch.output.count' } },
      },
    });
    const node = pyNode('print(count)');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('42\n');
  });

  // 布尔 inputs 注入
  test('布尔 inputs 注入为 Python True/False', async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: 'print(active)',
        inputs: { active: { value: true, rawExpression: 'nodes.fetch.output.active' } },
      },
    });
    const node = pyNode('print(active)');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('True\n');
  });

  // null inputs 注入为 None
  test('null inputs 注入为 Python None', async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: 'print(val)',
        inputs: { val: { value: null, rawExpression: 'nodes.fetch.output.missing' } },
      },
    });
    const node = pyNode('print(val)');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('None\n');
  });

  // 复杂对象 inputs 注入为 json.loads()
  test('对象 inputs 通过 json.loads() 注入', async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: 'print(data["result"])',
        inputs: {
          data: { value: { result: 'hello', count: 5 }, rawExpression: 'nodes.fetch.output' },
        },
      },
    });
    const node = pyNode('print(data["result"])');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('hello\n');
  });

  // 数组 inputs 注入
  test('数组 inputs 通过 json.loads() 注入', async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: 'print(len(items))',
        inputs: {
          items: { value: [1, 2, 3], rawExpression: 'nodes.fetch.output.items' },
        },
      },
    });
    const node = pyNode('print(len(items))');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('3\n');
  });

  // 多个 inputs 混合类型
  test('多个 inputs 混合类型正确注入', async () => {
    const ctx = makeCtx({
      resolvedInputs: {
        code: 'print(f"{name}={count}")',
        inputs: {
          name: { value: 'test', rawExpression: 'params.name' },
          count: { value: 10, rawExpression: 'nodes.fetch.output.count' },
        },
      },
    });
    const node = pyNode('print(f"{name}={count}")');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('test=10\n');
  });

  // secrets 注入为环境变量
  test('secrets 注入为子进程环境变量', async () => {
    const ctx = makeCtx({ secrets: { API_KEY: 'key123' } });
    const node = pyNode('import os; print(os.environ.get("API_KEY", ""))');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('key123\n');
  });

  // 无 inputs 时不注入 preamble
  test('无 inputs 时脚本正常执行', async () => {
    const ctx = makeCtx();
    const node = pyNode('print("no inputs")');
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe('no inputs\n');
  });
});

// ========== 重试测试 ==========

describe('PythonExecutor retry', () => {
  let executor: PythonExecutor;

  beforeEach(() => {
    executor = new PythonExecutor();
  });

  // 重试耗尽仍失败
  test('重试耗尽后仍然失败', async () => {
    const ctx = makeCtx();
    const node = pyNode('import sys; sys.exit(1)', {
      retry: { count: 1, delay: 50, backoff: 'fixed' },
    });

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: 'test-py-node' });
    const retryEvents = events.filter((e) => e.type === 'node.retrying');
    expect(retryEvents.length).toBe(1);
  });
});
