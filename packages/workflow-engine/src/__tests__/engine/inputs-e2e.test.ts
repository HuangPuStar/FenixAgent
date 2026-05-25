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
