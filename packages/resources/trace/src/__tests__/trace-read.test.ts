// src/__tests__/trace-read.test.ts
// 读取服务的三条边界（`../server/services/trace-read.ts`）。用例全部经注入端口（假客户端 + 假 Doc 查询），
// 不触网也不碰 DocManager——被测的正是「在拿到数据前后做对了什么判断」，而不是 Langfuse 的能力。
//
// 三条边界对应三个安全/可用性不变量：
//   1. 查谁由**服务端**决定：过滤条件取自 Doc 解析出的 ACP 会话 id，浏览器无从指定；
//   2. trace 必须属于该会话：按 traceId 的读取先比对 `sessionId`，不一致一律 404（不区分「不存在」与「不是你的」，
//      避免把归属校验变成枚举接口）；
//   3. 字段白名单：上游行经白名单收敛后才可能到达浏览器，兼容实现的新增字段默认不外泄。

import { describe, expect, test } from "bun:test";
import { NotFoundError } from "@fenix/platform-sdk";
import type {
  LangfuseClient,
  LangfuseObservationListParams,
  LangfuseTraceListParams,
} from "../server/services/langfuse-client";
import { LangfuseReadError } from "../server/services/langfuse-client";
import { createTraceReadService, type TraceReadPorts } from "../server/services/trace-read";

const CONNECTION = { baseUrl: "http://langfuse.test", publicKey: "pk", secretKey: "sk" };

/** 假客户端：记录每次调用的参数，按用例给返回值。 */
function createFakeClient(overrides: Partial<LangfuseClient> = {}) {
  const calls = {
    listTraces: [] as LangfuseTraceListParams[],
    getTrace: [] as string[],
    listObservations: [] as LangfuseObservationListParams[],
  };
  const client: LangfuseClient = {
    async listTraces<T>(params: LangfuseTraceListParams) {
      calls.listTraces.push(params);
      return {
        data: [{ id: "trace-1", sessionId: "ses-acp", timestamp: "2026-01-01T00:00:00.000Z", tags: ["a", 7] }] as T[],
        meta: { page: params.page, limit: params.limit, totalItems: 1, totalPages: 1 },
      };
    },
    async getTrace<T>(traceId: string) {
      calls.getTrace.push(traceId);
      return { id: traceId, sessionId: "ses-acp" } as T;
    },
    async listObservations<T>(params: LangfuseObservationListParams) {
      calls.listObservations.push(params);
      return {
        data: [
          {
            id: "obs-1",
            type: "TOOL",
            startTime: "2026-01-01T00:00:00.000Z",
            projectId: "proj-must-not-leak",
            inputPrice: 9.99,
            name: "Read",
          },
        ] as T[],
        meta: { cursor: "next-cursor" },
      };
    },
    ...overrides,
  };
  return { client, calls };
}

/** 端口装配：默认「已配置 + 有活跃 ACP 会话」，逐用例覆盖。 */
function createPorts(
  fake: ReturnType<typeof createFakeClient>,
  overrides: Partial<TraceReadPorts> = {},
): TraceReadPorts {
  return {
    resolveActiveAcpSessionId: () => "ses-acp",
    resolveConnection: () => CONNECTION,
    createClient: () => fake.client,
    ...overrides,
  };
}

describe("listSessionTraces", () => {
  // 业务意图：部署没接观测后端时返回 configured=false 而**不是**空列表——前端据此显示引导态；把「没配」表现成
  // 「这个会话没有 run」会让部署问题看起来像业务事实。
  test("未配置时返回 configured=false 且不创建客户端", async () => {
    let created = 0;
    const service = createTraceReadService(
      createPorts(createFakeClient(), {
        resolveConnection: () => null,
        createClient: () => {
          created++;
          throw new Error("不应创建客户端");
        },
      }),
    );

    expect(await service.listSessionTraces({ rcsSessionId: "rcs_1", page: 1, limit: 20 })).toEqual({
      configured: false,
      acpSessionId: null,
      traces: [],
      page: 1,
      totalItems: 0,
    });
    expect(created).toBe(0);
  });

  // 业务意图：已配置但该实例还没建立过 ACP 会话时，`acpSessionId: null` 与「没配置」是两种不同的事实——
  // 前者等用户发第一条消息，后者要去改部署。
  test("已配置但无活跃 ACP 会话时返回 acpSessionId=null", async () => {
    const service = createTraceReadService(createPorts(createFakeClient(), { resolveActiveAcpSessionId: () => null }));

    const result = await service.listSessionTraces({ rcsSessionId: "rcs_1", page: 1, limit: 20 });
    expect(result.configured).toBe(true);
    expect(result.acpSessionId).toBeNull();
    expect(result.traces).toEqual([]);
  });

  // 业务意图：过滤条件必须是 Doc 解析出的会话 id（而不是浏览器传来的实例 uid）；同时列表项要经整形——上游
  // 里混入的非字符串 tags 不能原样到达前端。
  test("按 Doc 解析出的会话 id 过滤，列表项经整形", async () => {
    const fake = createFakeClient();
    const service = createTraceReadService(createPorts(fake));

    const result = await service.listSessionTraces({ rcsSessionId: "rcs_1", page: 2, limit: 50 });

    expect(fake.calls.listTraces[0]).toEqual({ sessionId: "ses-acp", page: 2, limit: 50 });
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toMatchObject({ id: "trace-1", sessionId: "ses-acp", tags: ["a"], bookmarked: false });
    expect(result.totalItems).toBe(1);
  });

  // 业务意图：缺 id 的行无法被后续按 id 取详情（点了也打不开），必须在列表阶段丢弃；否则前端会拿到一条永远
  // 加载不出来的 run。
  test("缺 id 的上游行被丢弃", async () => {
    const fake = createFakeClient({
      async listTraces<T>() {
        return {
          data: [
            { id: "", sessionId: "ses-acp" },
            { id: "trace-2", sessionId: "ses-acp" },
          ] as T[],
          meta: { page: 1, limit: 20, totalItems: 2, totalPages: 1 },
        };
      },
    });
    const service = createTraceReadService(createPorts(fake));

    const result = await service.listSessionTraces({ rcsSessionId: "rcs_1", page: 1, limit: 20 });
    expect(result.traces.map((trace) => trace.id)).toEqual(["trace-2"]);
  });
});

describe("listTraceObservations", () => {
  // 业务意图：trace 不属于当前会话时按 404 处理（与「不存在」同响应）——归属校验不得成为枚举他人 trace 的接口。
  test("trace 不属于该会话时抛 NotFoundError", async () => {
    const fake = createFakeClient({
      async getTrace<T>() {
        return { id: "trace-1", sessionId: "别人的会话" } as T;
      },
    });
    const service = createTraceReadService(createPorts(fake));

    const failure = await service
      .listTraceObservations({ rcsSessionId: "rcs_1", traceId: "trace-1", limit: 50 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NotFoundError);
    expect(fake.calls.listObservations).toHaveLength(0);
  });

  // 业务意图：白名单是「兼容实现新增字段默认不外泄」的唯一收敛点——`projectId` 与 `*Price` 这类内部账务字段
  // 绝不能到达浏览器。同时列表阶段只请求摘要字段组（不含 IO），避免把工具输出整包搬过来。
  test("白名单过滤上游字段，且列表阶段不请求 IO", async () => {
    const fake = createFakeClient();
    const service = createTraceReadService(createPorts(fake));

    const page = await service.listTraceObservations({ rcsSessionId: "rcs_1", traceId: "trace-1", limit: 50 });

    expect(page.data[0]).toEqual({
      id: "obs-1",
      type: "TOOL",
      startTime: "2026-01-01T00:00:00.000Z",
      name: "Read",
    });
    expect(page.cursor).toBe("next-cursor");
    expect(fake.calls.listObservations[0]?.fields).not.toContain("io");
  });

  // 业务意图：工具名属于上游 `basic` 字段组；显式 `fields` 会取代默认的 core+basic，漏掉 basic 时 `name` 在
  // 响应里整体缺失，列表只能显示「工具」、详情显示「未命名」。
  test("列表与详情请求都包含 basic 字段组以取回名称", async () => {
    const fake = createFakeClient();
    const service = createTraceReadService(createPorts(fake));

    await service.listTraceObservations({ rcsSessionId: "rcs_1", traceId: "trace-1", limit: 50 });
    await service.getTraceObservation({ rcsSessionId: "rcs_1", traceId: "trace-1", observationId: "obs-1" });

    expect(fake.calls.listObservations).toHaveLength(2);
    for (const params of fake.calls.listObservations) {
      expect(params.fields.split(",")).toContain("basic");
    }
  });

  // 业务意图：缺渲染必需字段（`type`）的行无法定位节点，列表按「跳过该行」处理——一个畸形节点不该让整张图
  // 取不回来。
  test("缺必需字段的 observation 行被跳过", async () => {
    const fake = createFakeClient({
      async listObservations<T>() {
        return {
          data: [
            { id: "obs-1", startTime: "2026-01-01T00:00:00.000Z" },
            { id: "obs-2", type: "SPAN", startTime: "2026-01-01T00:00:01.000Z" },
          ] as T[],
          meta: { cursor: null },
        };
      },
    });
    const service = createTraceReadService(createPorts(fake));

    const page = await service.listTraceObservations({ rcsSessionId: "rcs_1", traceId: "trace-1", limit: 50 });
    expect(page.data.map((observation) => observation.id)).toEqual(["obs-2"]);
  });

  // 业务意图：会话尚未建立 ACP 会话时不可能有归属于它的 trace，一律 404；此时不得向上游发请求（省一次注定
  // 无果的调用，也让「Doc 里没有」这类事实不依赖上游行为）。
  test("无活跃会话时直接 404 且不访问上游", async () => {
    const fake = createFakeClient();
    const service = createTraceReadService(createPorts(fake, { resolveActiveAcpSessionId: () => null }));

    const failure = await service
      .listTraceObservations({ rcsSessionId: "rcs_1", traceId: "trace-1", limit: 50 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NotFoundError);
    expect(fake.calls.getTrace).toHaveLength(0);
  });
});

describe("getTraceObservation", () => {
  // 业务意图：单条读取必须同时按 id 与 traceId 过滤——即使上游 id 全局唯一，也不让「拿别人的 observation id
  // 试探」有可利用的路径。
  test("过滤条件同时包含 id 与 traceId，且请求 IO 字段", async () => {
    const fake = createFakeClient();
    const service = createTraceReadService(createPorts(fake));

    await service.getTraceObservation({ rcsSessionId: "rcs_1", traceId: "trace-1", observationId: "obs-1" });

    const params = fake.calls.listObservations[0];
    expect(params?.filter).toEqual([
      { type: "string", column: "id", operator: "=", value: "obs-1" },
      { type: "string", column: "traceId", operator: "=", value: "trace-1" },
    ]);
    expect(params?.fields).toContain("io");
  });

  // 业务意图：上游没返回该行 = 不存在（404）；而返回的行**缺必需字段** = 上游违反自己的契约，按上游故障上报，
  // 不要把它藏进 404——否则「上游坏了」会被显示成「记录不存在」。
  test("无匹配行 404，畸形行按上游故障上报", async () => {
    const empty = createFakeClient({
      async listObservations<T>() {
        return { data: [] as T[], meta: { cursor: null } };
      },
    });
    const malformed = createFakeClient({
      async listObservations<T>() {
        return { data: [{ id: "obs-1", startTime: "2026-01-01T00:00:00.000Z" }] as T[], meta: { cursor: null } };
      },
    });

    const missing = await createTraceReadService(createPorts(empty))
      .getTraceObservation({ rcsSessionId: "rcs_1", traceId: "trace-1", observationId: "obs-1" })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(NotFoundError);

    const invalid = await createTraceReadService(createPorts(malformed))
      .getTraceObservation({ rcsSessionId: "rcs_1", traceId: "trace-1", observationId: "obs-1" })
      .catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(LangfuseReadError);
    expect((invalid as LangfuseReadError).kind).toBe("invalid_response");
  });
});
