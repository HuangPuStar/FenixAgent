/**
 * 测试底座：loopback fixture 私有源 + packument 构造器 + 出网护栏。
 *
 * 契约测试**永远不能**打到真实 registry：那既慢又不稳定，还证明不了被测代码的任何性质。所有 NPM 交互都
 * 经一个临时端口上的 loopback 服务；记录器同时证明一条反向性质——从未请求过任何 tarball。
 *
 * 构造器刻意产出 registry **会返回的不可信形状**（含 `_npmUser`、`scripts` 一类扩展字段），使规范化逻辑
 * 在生产同款输入上被检验，而不是在理想化输入上。
 */

import type { FetchLike } from "../server/npm-registry/client";
import { LIMITS } from "../server/npm-registry/normalize";

export type FixtureContext = {
  request: Request;
  url: URL;
  /** 路径里百分号解码后的包名，如 `@acme/team`。 */
  packageName: string;
};

export type FixtureHandler = (context: FixtureContext) => Response | Promise<Response>;

export type FixtureRegistry = {
  baseUrl: string;
  /** 按到达顺序记录的请求路径。 */
  requests: string[];
  /** 看起来像制品下载的请求。必须始终为空。 */
  artifactRequests: string[];
  setHandler(handler: FixtureHandler): void;
  stop(): void;
};

/** 真实 sha512 SRI（88 个 base64 字符）。刻意写实：短的占位串曾掩盖过「拒绝一切已发布包」的校验缺陷。 */
export const SRI_DIGEST =
  "sha512-ySkKdW+6nSh2cvK986z0Cg2Od7YC8mjLglK35WPGgzFQ2ovXScbjMuF42SfzLNTl+4wcvScsBdT8md82I+aOSA==";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const jsonResponse = json;

/** 看起来像 tarball / 制品下载而不是元数据读取。 */
const ARTIFACT_PATTERN = /\.tgz$|\.tar\.gz$|\/-\//i;

export function startFixtureRegistry(initial: FixtureHandler): FixtureRegistry {
  let handler = initial;
  const requests: string[] = [];
  const artifactRequests: string[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (ARTIFACT_PATTERN.test(url.pathname)) artifactRequests.push(url.pathname);
      const packageName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      return handler({ request, url, packageName });
    },
  });

  return {
    baseUrl: server.url.toString().replace(/\/+$/, ""),
    requests,
    artifactRequests,
    setHandler(next) {
      handler = next;
    },
    stop() {
      server.stop(true);
    },
  };
}

/** 允许的 host：测试只应碰到 loopback。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * 「只允许 loopback」的出网护栏，作为 **`fetchImpl` 注入**给被测客户端。
 *
 * 为什么是注入而不是像源项目那样替换 `globalThis.fetch`：本仓库的 `bun test` 把所有测试文件放进同一个
 * 进程并交错执行，而**别的测试文件也会替换全局 fetch**（`packages/resources/memory` 的 hindsight 用例在
 * `beforeEach` 里换成返回 `{ source: "hindsight" }` 的替身，`workflow-engine` 的 api-executor 用假
 * Response 对象）。实测：替换全局 fetch 的版本在单跑本文件时全绿，在 `bun test packages/` 下 26/39 失败，
 * 失败原因是请求**根本没到达 fixture**（探针记录 `fixtureHits=0`）——被别人的替身截走了。注入式护栏没有
 * 这个面：本套件不写任何全局状态，也不读可能被别人改过的全局。
 *
 * 委托目标是 `Bun.fetch` 而不是 `globalThis.fetch`：前者是独立的原生实现，`globalThis.fetch` 被测试替换
 * 时它不受影响（实测：重写全局后 `Bun.fetch` 仍发起真实连接）。这样「真实 socket + 真实
 * `redirect: "manual"` 语义」这条覆盖也就不会被别人的替身悄悄换掉。
 *
 * 生产代码不受影响：`PluginRegistryClient` 的默认实现仍是可移植的 `globalThis.fetch`，本函数只存在于测试面。
 *
 * 拒绝以 **rejected promise** 而非同步 throw 的形式给出（故函数体是 `async`）：`FetchLike` 的契约是「返回
 * promise」，真实 fetch 的失败也都是 reject。同步 throw 会让护栏只有在调用方恰好包了 try 时才被看见，
 * 而调用方（客户端）是按 promise 拒绝来兜捕异常的。
 */
export function loopbackOnlyFetch(): FetchLike {
  return async (input, init) => {
    const host = new URL(input, "http://localhost").hostname;
    if (!LOOPBACK_HOSTS.has(host)) throw new Error(`Test network access refused: ${host}`);
    return Bun.fetch(input, init);
  };
}

export type AgentFixture = { id: string; name: string; description?: string };
export type SkillFixture = { uri: string; name: string; description?: string };
export type ServerFixture = { id: string; transport: string; runtime?: string };

export type PackumentInput = {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  deprecated?: string;
  integrity?: string;
  tarball?: string;
  unpackedSize?: number;
  fileCount?: number;
  time?: string;
  mcpp?: unknown;
  /** 敌意输入用例的逃生口。 */
  extraVersionFields?: Record<string, unknown>;
  extraPackumentFields?: Record<string, unknown>;
};

export const mcppMetadata = (input: {
  schemaVersion?: number;
  displayName?: string;
  summary?: string;
  agents?: AgentFixture[];
  skills?: SkillFixture[];
  servers?: ServerFixture[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> => ({
  schemaVersion: input.schemaVersion ?? 1,
  ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  ...(input.summary === undefined ? {} : { summary: input.summary }),
  ...(input.agents === undefined ? {} : { agents: input.agents }),
  ...(input.skills === undefined ? {} : { skills: input.skills }),
  ...(input.servers === undefined ? {} : { servers: input.servers }),
  ...(input.extra ?? {}),
});

/** 一个最小但合法的单版本 packument。 */
export const packumentFor = (input: PackumentInput): Record<string, unknown> => {
  const version: Record<string, unknown> = {
    name: input.name,
    version: input.version,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
    ...(input.deprecated === undefined ? {} : { deprecated: input.deprecated }),
    ...(input.mcpp === undefined ? {} : { mcpp: input.mcpp }),
    dist: {
      ...(input.integrity === undefined ? { integrity: SRI_DIGEST } : { integrity: input.integrity }),
      tarball: input.tarball ?? `https://registry.example.com/${input.name}/-/${input.name}-${input.version}.tgz`,
      ...(input.unpackedSize === undefined ? {} : { unpackedSize: input.unpackedSize }),
      ...(input.fileCount === undefined ? {} : { fileCount: input.fileCount }),
    },
    ...(input.extraVersionFields ?? {}),
  };

  return {
    name: input.name,
    "dist-tags": { latest: input.version },
    versions: { [input.version]: version },
    time: {
      created: "2026-01-01T00:00:00.000Z",
      [input.version]: input.time ?? "2026-08-01T00:00:00.000Z",
    },
    ...(input.extraPackumentFields ?? {}),
  };
};

/**
 * 构造一个足够深的嵌套对象以触发深度护栏。
 *
 * 上界从 `LIMITS` 取而不是写死常量：护栏若被调松，本构造器要跟着变宽才仍然越界——写死的数字会在那种
 * 情况下静默变成「合法输入」，用例继续通过却不再证明任何事。
 */
export const deeplyNested = (depth: number = LIMITS.maxJsonDepth + 4): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.child = next;
    cursor = next;
  }
  return root;
};
