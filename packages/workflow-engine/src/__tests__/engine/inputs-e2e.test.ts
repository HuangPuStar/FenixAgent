/**
 * 端到端测试 — 验证 inputs 数据在节点间正确传递。
 *
 * 注意：/bin/sh 不支持 echo -n，用 printf 去掉尾换行。
 * shell 的 echo 默认在 stdout 末尾加 \n，stdout 值会包含换行。
 */

import { describe, expect, test } from "bun:test";
import { createWorkflowEngine } from "../../engine/workflow-engine";
import { createInMemoryStorage } from "../../storage/in-memory-storage";

function makeEngine() {
  const storage = createInMemoryStorage();
  const engine = createWorkflowEngine({
    storage,
    hmacSecret: "test-hmac-secret-for-e2e",
  });
  return { engine, storage };
}

// ========== shell → shell 传递 ==========

describe("inputs 端到端：shell → shell", () => {
  test("上游 shell 输出通过 inputs 环境变量传递给下游", async () => {
    const { engine } = makeEngine();

    const yaml = `
name: shell-to-shell
schema_version: "1"
nodes:
  - id: greet
    type: shell
    command: printf "hello"
  - id: use_greeting
    type: shell
    depends_on: [greet]
    inputs:
      GREETING: nodes.greet.output.stdout
    command: printf "%s world" "$GREETING"
`;

    const result = await engine.run(yaml);
    expect(result.status).toBe("SUCCESS");

    const output = await engine.getOutput(result.runId, "use_greeting");
    expect(output?.stdout).toBe("hello world");
  });
});

// ========== shell → python 传递 ==========

describe("inputs 端到端：shell → python", () => {
  test("上游 shell JSON 输出通过 inputs 变量注入传递给 python", async () => {
    const { engine } = makeEngine();

    const yaml = `
name: shell-to-python
schema_version: "1"
nodes:
  - id: gen_data
    type: shell
    command: printf '{"name":"alice","age":30}'
  - id: use_data
    type: python
    depends_on: [gen_data]
    inputs:
      data: nodes.gen_data.output
    code: print(data["name"])
`;

    const result = await engine.run(yaml);
    expect(result.status).toBe("SUCCESS");

    const output = await engine.getOutput(result.runId, "use_data");
    expect(output?.stdout.trim()).toBe("alice");
  });
});

// ========== params 通过 inputs 注入 ==========

describe("inputs 端到端：params 注入", () => {
  // object 参数中的 JSON 文本应在运行入口解析，节点收到的是对象语义。
  test("object 参数 JSON 文本在执行前转换为对象", async () => {
    const { engine } = makeEngine();
    const yaml = `schema_version: '1'\nname: object-param\nparams:\n  payload:\n    type: object\nnodes:\n  - id: use-payload\n    type: shell\n    command: printf '%s' "$PAYLOAD"\n    inputs:\n      PAYLOAD: params.payload\n`;
    const { runId, result: completion } = engine.runAsync(yaml, { payload: '{"value":42}' });
    const result = await completion;
    expect(result.status).toBe("SUCCESS");
    const started = (await engine.getEvents(runId)).find((event) => event.type === "dag.started");
    expect(started?.metadata?.params).toEqual({ payload: { value: 42 } });
    expect((await engine.getOutput(runId, "use-payload"))?.stdout).toBe('{"value":42}');
  });

  // 非对象 JSON 不能作为声明为 object 的运行参数进入调度器。
  test("object 参数拒绝数组和非法 JSON", async () => {
    const { engine } = makeEngine();
    const yaml = `schema_version: '1'\nname: object-param\nparams:\n  payload:\n    type: object\nnodes:\n  - id: use-payload\n    type: shell\n    command: echo ok\n`;
    await expect(engine.run(yaml, { payload: "[1]" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(() => engine.runAsync(yaml, { payload: "{" })).toThrow();
  });
  test("params 通过 inputs 注入到 shell 环境变量", async () => {
    const { engine } = makeEngine();

    const yaml = `
name: params-shell
schema_version: "1"
params:
  name:
    type: string
    default: world
nodes:
  - id: greet
    type: shell
    inputs:
      NAME: params.name
    command: printf "hello %s" "$NAME"
`;

    const result = await engine.run(yaml);
    expect(result.status).toBe("SUCCESS");

    const output = await engine.getOutput(result.runId, "greet");
    expect(output?.stdout).toBe("hello world");
  });

  test("运行时 params 覆盖默认值", async () => {
    const { engine } = makeEngine();

    const yaml = `
name: params-override
schema_version: "1"
params:
  name:
    type: string
    default: world
nodes:
  - id: greet
    type: shell
    inputs:
      NAME: params.name
    command: printf "hello %s" "$NAME"
`;

    const result = await engine.run(yaml, { name: "Alice" });
    expect(result.status).toBe("SUCCESS");

    const output = await engine.getOutput(result.runId, "greet");
    expect(output?.stdout).toBe("hello Alice");
  });

  test("params 通过 inputs 注入到 python 变量", async () => {
    const { engine } = makeEngine();

    const yaml = `
name: params-python
schema_version: "1"
params:
  count:
    type: number
    default: 5
nodes:
  - id: compute
    type: python
    inputs:
      count: params.count
    code: print(count * 2)
`;

    const result = await engine.run(yaml);
    expect(result.status).toBe("SUCCESS");

    const output = await engine.getOutput(result.runId, "compute");
    expect(output?.stdout.trim()).toBe("10");
  });
});

describe("YAML 节点重试", () => {
  // 失败节点按 YAML 配置重试一次，依赖节点不能启动。
  test("失败 shell 重试一次后保持失败并跳过下游", async () => {
    const { engine, storage } = makeEngine();
    const yaml = `schema_version: '1'\nname: retry-failure\nnodes:\n  - id: fail\n    type: shell\n    command: exit 7\n    retry:\n      count: 1\n      delay: 0\n  - id: downstream\n    type: shell\n    command: echo reached\n    depends_on: [fail]\n`;
    const result = await engine.run(yaml);
    const events = await storage.getEvents(result.runId);

    expect(result.status).toBe("FAILED");
    expect(events.filter((event) => event.type === "node.retrying" && event.node_id === "fail")).toHaveLength(1);
    expect(events.filter((event) => event.type === "node.started" && event.node_id === "downstream")).toHaveLength(0);
  });
});

describe("运行取消", () => {
  // 取消等待命令后，运行快照应在原等待结束前进入取消终态。
  test("取消 sleep 节点及时生成 CANCELLED 快照", async () => {
    if (process.platform === "win32") return;
    const { engine } = makeEngine();
    const yaml = `schema_version: '1'\nname: cancellable\nnodes:\n  - id: wait\n    type: shell\n    command: sleep 3 & wait\n`;
    const { runId, result } = engine.runAsync(yaml);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelledAt = Date.now();
    await engine.cancel(runId);
    expect((await result).status).toBe("CANCELLED");
    expect((await engine.getRunStatus(runId))?.dag_status).toBe("CANCELLED");
    expect(Date.now() - cancelledAt).toBeLessThan(1500);
  });
});

// ========== secrets 通过 inputs 注入 ==========

describe("inputs 端到端：secrets 注入", () => {
  test("secrets 通过 inputs 注入到 shell 环境变量", async () => {
    process.env.API_KEY = "test-secret-key";

    try {
      const { engine } = makeEngine();

      const yaml = `
name: secrets-injection
schema_version: "1"
secrets:
  - API_KEY
nodes:
  - id: use_key
    type: shell
    inputs:
      KEY: secrets.API_KEY
    command: printf "key=%s" "$KEY"
`;

      const result = await engine.run(yaml);
      expect(result.status).toBe("SUCCESS");

      const output = await engine.getOutput(result.runId, "use_key");
      expect(output?.stdout).toBe("key=test-secret-key");
    } finally {
      delete process.env.API_KEY;
    }
  });
});

// ========== 多级链式传递 ==========

describe("inputs 端到端：多级链式传递", () => {
  test("shell → shell → shell 三级传递", async () => {
    const { engine } = makeEngine();

    const yaml = `
name: chain-passing
schema_version: "1"
nodes:
  - id: step1
    type: shell
    command: printf "first"
  - id: step2
    type: shell
    depends_on: [step1]
    inputs:
      PREV: nodes.step1.output.stdout
    command: printf "%s->second" "$PREV"
  - id: step3
    type: shell
    depends_on: [step2]
    inputs:
      PREV: nodes.step2.output.stdout
    command: printf "%s->third" "$PREV"
`;

    const result = await engine.run(yaml);
    expect(result.status).toBe("SUCCESS");

    const output = await engine.getOutput(result.runId, "step3");
    expect(output?.stdout).toBe("first->second->third");
  });
});

// ========== 并行节点独立 inputs ==========

describe("inputs 端到端：并行节点", () => {
  test("多个下游节点从同一上游获取不同 inputs", async () => {
    const { engine } = makeEngine();

    const yaml = `
name: parallel-inputs
schema_version: "1"
nodes:
  - id: source
    type: shell
    command: printf '{"x":10,"y":20}'
  - id: use_x
    type: python
    depends_on: [source]
    inputs:
      val: nodes.source.output.x
    code: print(val * 2)
  - id: use_y
    type: python
    depends_on: [source]
    inputs:
      val: nodes.source.output.y
    code: print(val + 5)
`;

    const result = await engine.run(yaml);
    expect(result.status).toBe("SUCCESS");

    const outputX = await engine.getOutput(result.runId, "use_x");
    expect(outputX?.stdout.trim()).toBe("20");

    const outputY = await engine.getOutput(result.runId, "use_y");
    expect(outputY?.stdout.trim()).toBe("25");
  });
});

// ========== inputs + env 共存 ==========

describe("inputs 端到端：inputs + env 共存", () => {
  test("shell 节点 inputs 和 env 同时生效", async () => {
    const { engine } = makeEngine();

    const yaml = `
name: inputs-env-coexist
schema_version: "1"
nodes:
  - id: step1
    type: shell
    command: printf "data"
  - id: step2
    type: shell
    depends_on: [step1]
    inputs:
      DATA: nodes.step1.output.stdout
    env:
      STATIC: constant
    command: printf "%s + %s" "$DATA" "$STATIC"
`;

    const result = await engine.run(yaml);
    expect(result.status).toBe("SUCCESS");

    const output = await engine.getOutput(result.runId, "step2");
    expect(output?.stdout).toBe("data + constant");
  });
});
