/** 临时 Environment 黑盒联调：仅调用公开 API，不读取数据库或应用内部服务。 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import * as z from "zod/v4";
import { testConcurrentConversations } from "./conversations";
import { TemporaryE2eHttp } from "./http";

const policySchema = z.object({
  source: z.enum(["default", "agent"]),
  ttlSeconds: z.number().int().positive().nullable(),
  effectiveTtlSeconds: z.number().int().positive(),
  maxTtlSeconds: z.number().int().positive(),
});
const environmentSchema = z.object({ environmentId: z.string(), instanceId: z.string(), expiresAt: z.string() });
const instanceSchema = z.object({
  instanceId: z.string(),
  environmentId: z.string(),
  status: z.enum(["stopped", "starting", "running", "stopping", "unknown"]),
  isDefault: z.boolean(),
  creationSource: z.enum(["api", "user"]),
});
const pageSchema = z.object({
  items: z.array(instanceSchema),
  total: z.number().int().nonnegative(),
  page: z.number(),
  pageSize: z.number(),
});
const uploadSchema = z.object({ environmentId: z.string(), files: z.array(z.object({ path: z.string() })) });
const treeSchema = z.object({
  environmentId: z.string(),
  paths: z.array(z.string()),
  errors: z.array(z.unknown()).optional(),
});
type Policy = z.infer<typeof policySchema>;
type Environment = z.infer<typeof environmentSchema>;

/** 用户只需配置 API Key 和 Agent ID，其余配置用于地址与超时调优。 */
interface Config {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  timeoutMs: number;
  expirySeconds: number;
  stopGraceMs: number;
}

const help = `临时 Agent Environment E2E

FENIX_USER_API_KEY='<用户 API Key>' FENIX_AGENT_ID='<Agent UUID>' \\
  bun run scripts/temporary-environments/e2e.ts

可选配置：
  FENIX_BASE_URL                 默认 http://127.0.0.1:3000，也接受 /api/v1 后缀
  TEMP_ENV_E2E_TIMEOUT_MS         单次 HTTP 超时，默认 120000
  TEMP_ENV_E2E_EXPIRY_SECONDS     到期阶段的 TTL，默认 5 秒
  TEMP_ENV_E2E_STOP_GRACE_MS      到期后等待严格停止，默认 60000

需要 Agent use/update 权限及可用执行节点。会临时修改指定 Agent 的 TTL，
结束或 Ctrl+C 后恢复原策略、停止本次实例；Environment、Instance 和测试文件保留。
Ctrl+C 会等待在途策略写入响应；超时、断网或无法确认的服务错误需人工核对策略。
需要两个可用运行槽位。A 使用 ACP、B 使用 OpenAI；每轮并发发送，共两轮、四次回复。
控制台逐次打印请求与响应，凭据脱敏。失败退出码 1，Ctrl+C 退出码 130。
重启补偿、停止失败注入和数据库回收确认不属于纯 API Key 自动测试范围。`;

function readConfig(): Config {
  const apiKey = process.env.FENIX_USER_API_KEY?.trim();
  const agentId = process.env.FENIX_AGENT_ID?.trim();
  if (!apiKey || !agentId) throw new Error("请配置 FENIX_USER_API_KEY 和 FENIX_AGENT_ID；用 --help 查看示例。");
  if (!z.uuid().safeParse(agentId).success) throw new Error("FENIX_AGENT_ID 必须是 Agent UUID。");
  let url: URL;
  try {
    url = new URL(process.env.FENIX_BASE_URL ?? "http://127.0.0.1:3000");
  } catch {
    throw new Error("FENIX_BASE_URL 必须是有效 HTTP(S) 地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("FENIX_BASE_URL 必须是无凭据、query 和 fragment 的 HTTP(S) 地址。");
  let baseUrl = url.href.replace(/\/+$/, "");
  if (!baseUrl.endsWith("/api/v1")) baseUrl += "/api/v1";
  const positive = (key: string, fallback: number) => {
    const value = Number(process.env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 必须是正整数。`);
    return value;
  };
  return {
    baseUrl,
    apiKey,
    agentId,
    timeoutMs: positive("TEMP_ENV_E2E_TIMEOUT_MS", 120_000),
    expirySeconds: positive("TEMP_ENV_E2E_EXPIRY_SECONDS", 5),
    stopGraceMs: positive("TEMP_ENV_E2E_STOP_GRACE_MS", 60_000),
  };
}

async function run(config: Config, signal: AbortSignal): Promise<void> {
  const http = new TemporaryE2eHttp({ ...config, signal });
  // 用户取消主流程后，恢复配置与停止实例仍必须有独立、有限的请求生命周期。
  const cleanup = new TemporaryE2eHttp({ ...config, signal: undefined });
  const agent = `/agents/${encodeURIComponent(config.agentId)}`;
  const policyPath = `${agent}/environment-policy`;
  const instances: string[] = [];
  let original: Policy | undefined;
  let confirmedTtl: number | undefined;
  let attemptedTtl: number | undefined;
  let policyWriteUnconfirmed = false;
  let currentStep = "初始化";
  let passed = 0;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  const step = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    currentStep = name;
    http.log(`\n[STEP] ${name}`);
    const result = await operation();
    passed++;
    http.log(`[PASS] ${name}`);
    return result;
  };
  const setTtl = async (seconds: number) => {
    // PUT 可能已生效但响应丢失，发出请求前就把它纳入恢复责任。
    attemptedTtl = seconds;
    policyWriteUnconfirmed = true;
    // 策略写入不跟随用户取消；先等服务端响应，再恢复，避免清理被迟到提交覆盖。
    const result = await cleanup.api("PUT", policyPath, policySchema, {
      json: { ttlSeconds: seconds },
      onResponseComplete: (status) => {
        // 同步成功和写入前的明确拒绝才能结算；网关错误或异步受理仍可能有迟到提交。
        policyWriteUnconfirmed = ![200, 400, 401, 403, 404, 422].includes(status);
      },
    });
    assert.equal(result.effectiveTtlSeconds, seconds);
    assert.equal(result.source, "agent");
    confirmedTtl = seconds;
    signal.throwIfAborted();
  };
  const create = async () => {
    const result = await http.api("POST", `${agent}/environments`, environmentSchema, {
      json: { temporary: true },
      expected: 201,
    });
    instances.push(result.instanceId);
    assert.ok(result.environmentId.startsWith("temp-"), "临时环境必须使用 temp- 身份");
    assert.ok(result.instanceId.startsWith("inst_"), "必须返回持久实例 ID");
    assert.ok(Date.parse(result.expiresAt) > Date.now(), "创建必须返回未来的有效期限");
    return result;
  };
  const identity = (expected: Environment, actual: { instanceId: string; environmentId: string }) => {
    assert.equal(actual.instanceId, expected.instanceId, "不得换用其他 Instance");
    assert.equal(actual.environmentId, expected.environmentId, "不得换用其他 Environment");
  };
  const connect = async (environment: Environment) => {
    const result = await http.api(
      "POST",
      `${agent}/instances/connect`,
      instanceSchema
        .omit({ creationSource: true, isDefault: true })
        .extend({ relay: z.object({ wsUrl: z.string().min(1) }) }),
      { json: { instanceId: environment.instanceId } },
    );
    identity(environment, result);
    assert.equal(result.status, "running");
    return result;
  };
  const renew = async (environment: Environment) => {
    const result = await http.api(
      "POST",
      `/environments/${environment.environmentId}/renew`,
      environmentSchema.extend({ status: z.literal("running") }),
      { json: {} },
    );
    identity(environment, result);
    assert.ok(Date.parse(result.expiresAt) > Date.now(), "renew 必须返回有效期限");
    return result;
  };
  const waitStopped = async (client: TemporaryE2eHttp, id: string, signal?: AbortSignal) => {
    const deadline = Date.now() + config.stopGraceMs;
    do {
      const result = await client.api("GET", `/instances/${id}`, instanceSchema);
      if (result.status === "stopped") return;
      assert.notEqual(result.status, "unknown", "后台停止未确认，请检查服务端日志");
      await sleep(500, undefined, { signal });
    } while (Date.now() < deadline);
    throw new Error(`后台停止未在宽限时间内完成：${id}`);
  };
  const stop = async (environment: Environment) => {
    await http.api("POST", `/instances/${environment.instanceId}/stop`, z.null(), { expected: 202 });
    await waitStopped(http, environment.instanceId, signal);
  };
  const list = async (filter?: string) => {
    const found: z.infer<typeof instanceSchema>[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 1000; page++) {
      const query = new URLSearchParams({ page: String(page), pageSize: "100" });
      if (filter) query.set("environmentType", filter);
      const result = await http.api("GET", `${agent}/instances?${query}`, pageSchema);
      assert.equal(result.page, page);
      assert.equal(result.pageSize, 100);
      for (const item of result.items) {
        assert.ok(!seen.has(item.instanceId), "分页不能重复实例");
        seen.add(item.instanceId);
        found.push(item);
        if (!filter || filter === "regular") assert.ok(!item.environmentId.startsWith("temp-"));
        if (filter === "temporary") assert.ok(item.environmentId.startsWith("temp-"));
      }
      if (page * 100 >= result.total) {
        assert.equal(found.length, result.total);
        return found;
      }
      assert.ok(result.items.length > 0, "尚有数据时分页不能提前返回空集合");
    }
    throw new Error("实例列表超过 1000 页，请使用专用测试 Agent。");
  };
  const fileName = `temp-env-e2e-${crypto.randomUUID()}.txt`;
  const filePath = `user/${fileName}`;
  const contentA = `environment-A-${crypto.randomUUID()}`;
  const contentB = `environment-B-${crypto.randomUUID()}`;
  const fileBase = (environment: Environment) => `/environments/${environment.environmentId}/workspace/files`;
  const upload = async (environment: Environment, content: string) => {
    const form = new FormData();
    form.set("path", "user");
    form.append("files", new File([content], fileName, { type: "text/plain" }));
    const result = await http.api("POST", fileBase(environment), uploadSchema, { form });
    assert.equal(result.environmentId, environment.environmentId);
    assert.ok(result.files.some((file) => file.path === filePath));
  };
  const download = async (environment: Environment, content: string) => {
    const response = await http.request(
      "GET",
      `${fileBase(environment)}/download?${new URLSearchParams({ path: filePath })}`,
    );
    assert.equal(response.text, content, "文件内容必须属于当前 Environment");
  };
  try {
    http.log(`临时环境 E2E：${config.baseUrl}；Agent ${config.agentId}`);
    http.log("会临时修改 Agent TTL，结束后恢复；A/ACP、B/OpenAI 并发各测两轮，需要两个运行槽位。");
    original = await step("读取并保存原 TTL 策略", () => http.api("GET", policyPath, policySchema));
    assert.ok(config.expirySeconds <= original.maxTtlSeconds, "到期测试 TTL 超过部署上限");
    const activeTtl = Math.min(
      original.maxTtlSeconds,
      Math.max(
        original.effectiveTtlSeconds,
        300,
        Math.ceil(config.timeoutMs / 1000) * 3 + 60,
        config.expirySeconds + 60,
      ),
    );
    await step("设置准备阶段 TTL", () => setTtl(activeTtl));
    const a = await step("创建临时环境 A", create);
    const b = await step("创建独立临时环境 B", create);
    assert.notEqual(a.environmentId, b.environmentId);
    assert.notEqual(a.instanceId, b.instanceId);
    await step("创建不启动 Runtime", async () => {
      for (const environment of [a, b]) {
        const result = await http.api("GET", `/instances/${environment.instanceId}`, instanceSchema);
        identity(environment, result);
        assert.equal(result.status, "stopped");
        assert.equal(result.isDefault, false);
        assert.equal(result.creationSource, "api");
      }
    });
    await step("默认和 regular 列表排除临时实例", async () => {
      await list();
      await list("regular");
    });
    await step("temporary 和 all 列表可找回两个新实例", async () => {
      for (const filter of ["temporary", "all"]) {
        const result = await list(filter);
        for (const id of instances) assert.ok(result.some((item) => item.instanceId === id));
      }
    });
    await step("拒绝非法列表筛选参数", () =>
      http.request("GET", `${agent}/instances?environmentType=invalid`, { expected: [400, 422] }),
    );
    const connected = await step("并发启动 A、B 两个实例", async () => {
      const results = await Promise.allSettled([connect(a), connect(b)]);
      if (results[0].status === "rejected" || results[1].status === "rejected") {
        throw new AggregateError(
          results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason),
          "并发启动失败；需要两个可用运行槽位，请检查上方 HTTP 响应",
        );
      }
      return { a: results[0].value, b: results[1].value };
    });
    await step("A/ACP 与 B/OpenAI 并发进行两轮会话并验证上下文", () =>
      testConcurrentConversations({ ...config, signal }, connected.a.relay.wsUrl, b.instanceId),
    );
    await step("A 上传并读取测试文件", async () => {
      await upload(a, contentA);
      await download(a, contentA);
    });
    await step("B 看不到 A 的文件，同名文件独立保存", async () => {
      const tree = await http.api("GET", fileBase(b), treeSchema);
      assert.equal(tree.environmentId, b.environmentId);
      assert.equal(tree.errors?.length ?? 0, 0, "文件树不完整时不能判定隔离成功");
      assert.ok(!tree.paths.includes(filePath), "B 不得看到 A 上传的文件");
      await upload(b, contentB);
      await download(b, contentB);
    });
    await step("两轮会话完成后停止 A、B", async () => {
      await stop(a);
      await stop(b);
    });
    await step("续期复用 A 的身份和文件", async () => {
      const updated = await renew(a);
      assert.ok(Date.parse(updated.expiresAt) > Date.parse(a.expiresAt), "准备阶段续期应延长期限");
      await download(a, contentA);
    });
    await step("设置短 TTL 并发布新的到期期限", () => setTtl(config.expirySeconds));
    const expiring = await step("对运行中的 A 写入短期限", () => renew(a));
    await step("到期自动停止 Runtime", async () => {
      const wait = Math.max(0, Date.parse(expiring.expiresAt) - Date.now()) + 250;
      assert.ok(wait <= config.expirySeconds * 1000 + 10_000, "服务端期限与本机时钟偏差过大");
      http.log(`等待到期：${expiring.expiresAt}，约 ${Math.ceil(wait / 1000)} 秒`);
      await sleep(wait, undefined, { signal });
      const deadline = Date.now() + config.stopGraceMs;
      do {
        const result = await http.api("GET", `/instances/${a.instanceId}`, instanceSchema);
        if (result.status === "stopped") return;
        await sleep(500, undefined, { signal });
      } while (Date.now() < deadline);
      throw new Error("到期后 Runtime 未在宽限时间内停止");
    });
    await step("过期 connect 和聊天均返回 410", async () => {
      const connectResult = await http.request("POST", `${agent}/instances/connect`, {
        json: { instanceId: a.instanceId },
        expected: 410,
      });
      const chatResult = await http.request("POST", "/chat/completions", {
        headers: { "X-Instance-Id": a.instanceId },
        json: { model: config.agentId, stream: false, messages: [{ role: "user", content: "不应执行此消息" }] },
        expected: 410,
      });
      const error = z.object({ error: z.object({ code: z.literal("ENVIRONMENT_EXPIRED") }) });
      error.parse(connectResult.json);
      error.parse(chatResult.json);
    });
    await step("过期记录仍可通过临时实例列表找回", async () => {
      const result = await list("temporary");
      for (const id of instances) assert.ok(result.some((item) => item.instanceId === id));
    });
    await step("过期后显式续期恢复原实例和文件", async () => {
      await setTtl(activeTtl);
      await renew(a);
      await download(a, contentA);
    });
  } catch (error) {
    failure = error;
    http.log(`[FAIL] ${currentStep}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    const clean = async (name: string, operation: () => Promise<void>) => {
      try {
        await operation();
        cleanup.log(`[PASS] 清理：${name}`);
      } catch (error) {
        cleanupErrors.push(error);
        cleanup.log(`[FAIL] 清理失败：${name}：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (original && attemptedTtl !== undefined) {
      const saved = original;
      await clean("恢复原 TTL 策略", async () => {
        assert.ok(
          !policyWriteUnconfirmed,
          "TTL 策略写入结果未确认，不能保证自动恢复；请等待服务端写入结束后人工核对原策略。",
        );
        const current = await cleanup.api("GET", policyPath, policySchema);
        if (current.source === saved.source && current.ttlSeconds === saved.ttlSeconds) return;
        // 失败 PUT 既可能已落库，也可能保留上次成功写入值；两者都属于本次测试的恢复责任。
        assert.ok(
          current.source === "agent" && (current.ttlSeconds === confirmedTtl || current.ttlSeconds === attemptedTtl),
          "策略已被其他调用方修改，请人工核对，脚本不覆盖该变更",
        );
        if (saved.source === "default") await cleanup.api("DELETE", policyPath, z.null());
        else await cleanup.api("PUT", policyPath, policySchema, { json: { ttlSeconds: saved.ttlSeconds } });
        const restored = await cleanup.api("GET", policyPath, policySchema);
        assert.equal(restored.source, saved.source);
        assert.equal(restored.ttlSeconds, saved.ttlSeconds);
      });
    }
    for (const id of instances)
      await clean(`停止 ${id}`, async () => {
        await cleanup.api("POST", `/instances/${id}/stop`, z.null(), { expected: 202 });
        await waitStopped(cleanup, id);
      });
    cleanup.log(`\n测试资源：${instances.join(", ") || "未创建"}；记录和文件按 TTL 设计保留。`);
    cleanup.log("[MANUAL] 本脚本未验证服务重启、停止失败注入及数据库 expiryReclaimedAt 持久确认。");
    cleanup.log(`[SUMMARY] 主流程通过 ${passed} 项；失败 ${failure ? 1 : 0} 项；清理失败 ${cleanupErrors.length} 项。`);
  }
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      "临时环境 E2E 未全部通过，请查看上方请求与响应。",
    );
}

if (import.meta.main) {
  if (Bun.argv.slice(2).includes("--help")) console.log(help);
  else {
    const controller = new AbortController();
    const interrupt = () => {
      if (controller.signal.aborted) return;
      controller.abort(new Error("用户取消测试"));
      console.log("[CANCELLED] 已请求取消，等待在途策略写入确认并清理。");
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    let config: Config | undefined;
    try {
      if (Bun.argv.length > 2) throw new Error("配置通过环境变量传入；仅支持 --help 参数。");
      config = readConfig();
      await run(config, controller.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (config) new TemporaryE2eHttp(config).log(`[FAIL] ${message}`);
      else console.error(`[FAIL] ${message}`);
      process.exitCode = controller.signal.aborted ? 130 : 1;
    } finally {
      if (controller.signal.aborted) {
        console.log("[CANCELLED] 测试被用户中断，退出码 130。");
        process.exitCode = 130;
      }
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}
