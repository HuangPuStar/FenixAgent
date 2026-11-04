import assert from "node:assert/strict";
import { type AgentTestConfig, validateConnectionConfig } from "./config";
import { testAcpConversation, testOpenAiConversation } from "./conversations";
import { field, type ManualRunner, object, pageItems } from "./runner";

/** Agent 相关 HTTP 接口；读写回查与多轮聊天会重复调用。 */
export const AGENT_OPERATIONS = [
  ...["agents", "providers", "skills", "mcp-servers"].flatMap((resource) => [
    `GET /api/v1/${resource}`,
    `POST /api/v1/${resource}`,
    ...["GET", "PATCH", "DELETE"].map(
      (method) => `${method} /api/v1/${resource}/{${resource === "providers" ? "providerId" : "id"}}`,
    ),
  ]),
  "GET /api/v1/providers/{providerId}/models",
  "POST /api/v1/providers/{providerId}/models",
  ...["GET", "PATCH", "DELETE"].map((method) => `${method} /api/v1/providers/{providerId}/models/{id}`),
  "GET /api/v1/knowledge-bases",
  "GET /api/v1/agents/{id}/instances",
  "POST /api/v1/agents/{id}/instances/connect",
  "GET /api/v1/instances/{id}",
  "POST /api/v1/instances/{id}/stop",
  "POST /api/v1/instances/{id}/restart",
  "POST /api/v1/environments/{environmentId}/workspace/files",
  "POST /api/v1/chat/completions",
].sort();

/** 创建测试资源前校验 Agent 所需配置。 */
export function validateAgentConfig(config: AgentTestConfig): void {
  validateConnectionConfig(config, "AGENT_CONFIG");
  for (const [key, value] of Object.entries({
    upstreamModel: config.upstreamModel,
    knowledgeBaseId: config.knowledgeBaseId,
    mcpConfig: JSON.stringify(config.mcpConfig),
    "provider.baseUrl": config.provider.baseUrl,
  }))
    assert.ok(
      value && !value.includes("EDIT_"),
      `请先填写本地配置 test-external-api-v1.config.local.ts 中的 AGENT_CONFIG.${key}（可先用 --list 查看覆盖接口）`,
    );
  assert.ok(
    !config.provider.apiKey.includes("EDIT_"),
    "请填写 AGENT_CONFIG.provider.apiKey，无认证的本地模型可设为空字符串",
  );
  assert.ok(!config.runtimeModelId.includes("EDIT_"), "请填写 runtimeModelId 或设为空字符串使用本轮创建的模型");
}

/** 执行资源 CRUD、绑定、实例、上传和两种三轮对话，仅清理本轮创建的资源。 */
export async function runAgentScenario(
  config: AgentTestConfig,
  runner: ManualRunner,
  resources: Record<string, string>,
): Promise<void> {
  const prefix = `/api/v1`;
  const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const name = `api-test-${suffix}`;
  const idPath = (value: string) => encodeURIComponent(value);
  const collection = (resource: string) => `${prefix}/${resource}`;
  const list = async (path: string): Promise<Record<string, unknown>[]> => {
    const all: Record<string, unknown>[] = [];
    let total = 0;
    for (let page = 1; ; page++) {
      await runner.request("GET", `${path}?page=${page}&pageSize=100`, {
        check: (data) => {
          const items = pageItems(data);
          assert.equal(object(data).page, page);
          total = Number(object(data).total);
          assert.ok(items.length > 0 || all.length >= total, "分页未返回预期条目");
          all.push(...items);
        },
      });
      if (all.length >= total) return all;
    }
  };
  const create = async (key: string, path: string, body: unknown): Promise<string> => {
    await runner.request("POST", path, {
      body,
      status: 201,
      check: (data) => {
        resources[key] = field(data, "id");
      },
    });
    return resources[key];
  };
  const get = async (path: string, check?: (data: Record<string, unknown>) => void) =>
    runner.request("GET", path, {
      check: (data) => {
        object(data);
        check?.(object(data));
      },
    });
  const patch = async (path: string, body: unknown) => runner.request("PATCH", path, { body });
  const remove = async (key: string, path: string) => {
    await runner.request("DELETE", path, { check: (data) => assert.equal(data, null, "删除应返回 data: null") });
    delete resources[key];
  };

  const providerId = await create("providerId", collection("providers"), {
    name,
    displayName: name,
    ...config.provider,
    publicReadable: false,
  });
  const provider = `${collection("providers")}/${idPath(providerId)}`;
  await list(collection("providers"));
  await get(provider, (data) => {
    assert.equal(data.kind, "direct");
    assert.ok(!Object.hasOwn(data, "apiKey"));
  });
  await patch(provider, { displayName: `${name}-updated` });
  await get(provider, (data) => assert.equal(data.displayName, `${name}-updated`));

  const modelId = await create("modelId", `${provider}/models`, { modelId: config.upstreamModel, displayName: name });
  const model = `${provider}/models/${idPath(modelId)}`;
  await list(`${provider}/models`);
  await get(model, (data) => assert.equal(data.modelId, config.upstreamModel));
  await patch(model, { displayName: `${name}-updated` });
  await get(model, (data) => assert.equal(data.displayName, `${name}-updated`));

  const skillContent = `---\nname: ${name}\ndescription: API 手工测试技能\n---\n\n测试技能口令：SKILL_${suffix}\n`;
  const form = new FormData();
  form.set(
    "manifest",
    JSON.stringify([
      { skillName: name, relativePath: "SKILL.md" },
      { skillName: name, relativePath: "assets/probe.bin" },
    ]),
  );
  form.append("files", new File([skillContent], "SKILL.md", { type: "text/markdown" }));
  form.append("files", new File([new Uint8Array([0, 1, 128, 255])], "probe.bin", { type: "application/octet-stream" }));
  const skillId = await create("skillId", collection("skills"), form);
  const skill = `${collection("skills")}/${idPath(skillId)}`;
  await list(collection("skills"));
  await get(skill, (data) => assert.ok(field(data, "content").includes(`SKILL_${suffix}`)));
  await patch(skill, { description: "API 手工测试技能（已更新）", metadata: { testRun: suffix } });
  await get(skill, (data) => assert.equal(object(data.metadata).testRun, suffix));

  const mcpId = await create("mcpId", collection("mcp-servers"), {
    name,
    config: config.mcpConfig,
    publicReadable: false,
  });
  const mcp = `${collection("mcp-servers")}/${idPath(mcpId)}`;
  await list(collection("mcp-servers"));
  await get(mcp);
  await patch(mcp, { enabled: false });
  await get(mcp, (data) => assert.equal(data.enabled, false));
  await patch(mcp, { config: { ...config.mcpConfig, enabled: true } });
  await get(mcp, (data) => assert.equal(data.enabled, true));

  const knowledgeBases = await list(collection("knowledge-bases"));
  assert.ok(
    knowledgeBases.some((kb) => kb.id === config.knowledgeBaseId),
    "配置的 knowledgeBaseId 不在可见知识库中",
  );
  const agentId = await create("agentId", collection("agents"), {
    name,
    modelId: config.runtimeModelId || modelId,
    description: "外部 API 全流程手工测试",
    prompt: "按用户要求回答，准确记住当前对话中的口令。",
    agentNode: config.agentNode,
    skillIds: [skillId],
    mcpIds: [mcpId],
    knowledge: { knowledgeBaseIds: [config.knowledgeBaseId] },
    enableMemory: false,
  });
  const agent = `${collection("agents")}/${idPath(agentId)}`;
  const checkBindings = (data: Record<string, unknown>) => {
    assert.deepEqual(data.skillIds, [skillId]);
    assert.deepEqual(data.mcpIds, [mcpId]);
    assert.deepEqual(object(data.knowledge).knowledgeBaseIds, [config.knowledgeBaseId]);
    assert.equal(data.modelId, config.runtimeModelId || modelId);
  };
  await list(collection("agents"));
  await get(agent, checkBindings);
  await patch(agent, { description: "外部 API 全流程手工测试（已更新）" });
  await get(agent, (data) => {
    checkBindings(data);
    assert.equal(data.description, "外部 API 全流程手工测试（已更新）");
  });

  let wsUrl = "";
  let generation = 0;
  await runner.request("POST", `${agent}/instances/connect`, {
    body: {},
    check: (data) => {
      resources.instanceId = field(data, "instanceId");
      resources.environmentId = field(data, "environmentId");
      wsUrl = field(object(data).relay, "wsUrl");
      assert.equal(object(data).status, "running");
      generation = Number(object(data).runtimeGeneration);
    },
  });
  const instance = `${collection("instances")}/${idPath(resources.instanceId)}`;
  await list(`${agent}/instances`);
  await get(instance, (data) => {
    assert.equal(data.agentConfigId, agentId);
    assert.equal(data.status, "running");
  });
  const upload = new FormData();
  upload.set("path", `user/${name}`);
  upload.set("relativePaths", JSON.stringify(["probe.txt", "nested/binary.bin"]));
  upload.append("files", new File([`UPLOAD_${suffix}\n`], "probe.txt", { type: "text/plain" }));
  upload.append("files", new File([new Uint8Array([0, 128, 255])], "binary.bin", { type: "application/octet-stream" }));
  await runner.request("POST", `${collection("environments")}/${idPath(resources.environmentId)}/workspace/files`, {
    body: upload,
    check: (data) => {
      assert.equal(object(data).environmentId, resources.environmentId);
      const files = object(data).files;
      assert.ok(Array.isArray(files) && files.length === 2);
      assert.deepEqual(
        files.map((file) => field(file, "path")),
        [`user/${name}/probe.txt`, `user/${name}/nested/binary.bin`],
      );
      resources.uploadPath = `user/${name}`;
    },
  });
  await testOpenAiConversation(runner, agentId, resources.instanceId);
  await testAcpConversation(runner, wsUrl, config.acpPermission);

  await runner.request("POST", `${instance}/restart`, {
    body: {},
    check: (data) => {
      assert.equal(object(data).status, "running");
      assert.ok(Number(object(data).runtimeGeneration) > generation, "重启没有更新 runtime generation");
    },
  });
  await get(instance, (data) => assert.equal(data.status, "running"));
  await runner.request("POST", `${instance}/stop`, {
    body: {},
    check: (data) => assert.equal(data, null, "stop 应返回 data: null"),
  });
  await get(instance, (data) => assert.equal(data.status, "stopped"));

  runner.print("开始清理", "以下 DELETE 仅针对本轮创建的资源；上传文件没有 v1 删除接口，会保留。");
  await remove("agentId", agent);
  await remove("skillId", skill);
  await remove("mcpId", mcp);
  await remove("modelId", model);
  await remove("providerId", provider);
  const missing = AGENT_OPERATIONS.filter((operation) => !runner.operations.has(operation));
  assert.deepEqual(missing, [], "有接口未覆盖");
  runner.print("测试完成", {
    covered: runner.operations.size,
    expected: AGENT_OPERATIONS.length,
    retained: resources,
  });
}
