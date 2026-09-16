import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "../../../..");
const SERVER_ENTRY = resolve(import.meta.dir, "../server.ts");

const OLD_RMD01_RUNTIME_PATHS = [
  "src/routes/acp/index.ts",
  "src/routes/api/instances.ts",
  "src/routes/api/openai-chat.ts",
  "src/schemas/acp.schema.ts",
  "src/schemas/environment.schema.ts",
  "src/schemas/instance.schema.ts",
  "src/schemas/openai-chat.schema.ts",
  "src/services/acp-idle-monitor.ts",
  "src/services/agent-chat-service.ts",
  "src/services/agent-concurrency.ts",
  "src/services/environment.ts",
  "src/services/environment-acp.ts",
  "src/services/environment-core.ts",
  "src/services/environment-startup-lock.ts",
  "src/services/instance-registry.ts",
  "src/services/launch-spec-builder.ts",
  "src/services/orchestration-bootstrap.ts",
  "src/services/orchestration-instance.ts",
  "src/services/orchestration-machine-cleanup.ts",
  "src/services/session.ts",
  "src/transport/agent-node-bridge.ts",
  "src/transport/event-bus.ts",
];

describe("RMD-01 agent-runtime 公开迁移面", () => {
  // 宿主只能经稳定 server 入口装配 ACP 与两条外部 API 路由。
  test("server 入口导出迁入后的 ACP、instances 与 OpenAI Chat 路由", () => {
    const source = readFileSync(SERVER_ENTRY, "utf8");

    expect(source).toContain('export { default as acpRoutes } from "./routes/acp"');
    expect(source).toContain('export { default as apiInstanceRoutes } from "./routes/api/instances"');
    expect(source).toContain('export { default as openaiChatRoutes } from "./routes/api/openai-chat"');
  });

  // 物理迁移完成后，旧根后端路径不得残留为第二份 runtime 实现。
  test("旧 RMD-01 后端源路径均不存在", () => {
    expect(OLD_RMD01_RUNTIME_PATHS.filter((path) => existsSync(resolve(PROJECT_ROOT, path)))).toEqual([]);
  });
});
