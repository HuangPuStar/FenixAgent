/**
 * `/workflow-ui` 静态资源代理。
 *
 * 把控制台请求透传到内部 `acpx-g` 服务（工作流前端界面及其依赖资源由它提供）。
 *
 * 改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state` 是实例作用域的，
 * 父实例无法向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`。
 * 转发目标不再读宿主 `@server/config`，而是经模块配置的 `acpxGUrl` 取得。
 */

import Elysia from "elysia";
import { getWorkflowConfig } from "../../config";
import type { WorkflowRouteDependencies } from "../dependencies";

/**
 * 转发路径的单段合法性判定。
 *
 * `:path` 只匹配一个 URL 段，但段内的 `%2F` 会被 Elysia 解码成 `/`（1.4.30 实测：请求
 * `/workflow-ui/..%2F..%2Fadmin` 得到 `params.path === "/../../admin"`，`%2e%2e%2f` 同样解码），
 * 于是单个段里可以夹带任意层级的点段。这些点段一旦参与字符串拼接，`fetch` 解析 URL 时会把它们归一化掉，
 * 请求就落到了 `/workflow-ui` 前缀之外：客户端无需上游配合，就能把静态资源代理变成对内网任意路径的读取
 * 入口（`/workflow-ui/..%2F..%2Fadmin` → 上游收到 `GET /admin`）。
 * 因此按「解码后逐段白名单」拒绝 `.`、`..`、空段、路径分隔符与控制字符。
 */
function isSafePathSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  for (const ch of segment) {
    const code = ch.codePointAt(0) ?? 0;
    // 控制字符会被下游按各自规则二次解释，分隔符则是段内 `%2F` 解码后的产物
    if (code < 0x20 || code === 0x7f) return false;
    if (ch === "/" || ch === "\\") return false;
  }
  return true;
}

/**
 * 把挂载点之后的请求路径映射为转发目标 URL；返回 `null` 表示该路径必须拒绝。
 *
 * `targetPath` 为空串表示挂载根路径（该分支没有用户输入参与拼接，因此无需逐段校验）。
 * `params.path` 带前导 `/`（1.4.30 实测 `/workflow-ui/app.js` → `"/app.js"`），先归一掉前导分隔符
 * 再逐段校验，后用 `encodeURIComponent` 重新编码，保证送进 URL 的 `.` 只可能是数据而非路径语义。
 */
function buildTargetUrl(acpxGUrl: string, targetPath: string): URL | null {
  const base = new URL(acpxGUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  if (targetPath === "") return new URL(`${basePath}/`, base);

  let decoded: string;
  try {
    decoded = decodeURIComponent(targetPath);
  } catch {
    // 非法百分号转义（如裸 `%`）：无法判断原始意图，按拒绝处理
    return null;
  }

  const rawSegments = decoded.replace(/^\/+/, "").split("/");
  const trailingSlash = rawSegments.length > 1 && rawSegments[rawSegments.length - 1] === "";
  const segments = trailingSlash ? rawSegments.slice(0, -1) : rawSegments;
  if (segments.length === 0 || !segments.every(isSafePathSegment)) return null;

  const encodedPath = segments.map(encodeURIComponent).join("/") + (trailingSlash ? "/" : "");
  const target = new URL(`${basePath}/${encodedPath}`, base);
  // 双保险：即使将来有人改回字符串拼接，前缀校验也会拦下越界的转发目标
  if (target.origin !== base.origin || !target.pathname.startsWith(`${basePath}/`)) return null;
  return target;
}

/** 将请求转发到 acpx-g 并流式返回响应。 */
async function proxyToAcpxG(acpxGUrl: string, targetPath: string, request: Request): Promise<Response> {
  const targetUrl = buildTargetUrl(acpxGUrl, targetPath);
  if (!targetUrl) {
    // 不回显被拒路径：它是不可信输入，回显既无诊断价值，又把代理变成了探测回显面
    return new Response(
      JSON.stringify({
        error: { type: "invalid_path", message: "path escapes the /workflow-ui proxy prefix" },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const headers = new Headers(request.headers);
  headers.set("Host", targetUrl.host);
  const init: RequestInit = {
    method: request.method,
    headers,
    // 透传客户端 abort 信号：客户端断连时上游请求也取消，避免占用下游资源
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  try {
    const res = await fetch(targetUrl, init);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err: unknown) {
    // 客户端主动断连属于预期行为，不当作 502 上报
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(null, { status: 499, statusText: "Client Closed Request" });
    }
    return new Response(
      JSON.stringify({
        error: {
          type: "bad_gateway",
          message: `acpx-g unreachable: ${err instanceof Error ? err.message : String(err)}`,
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** 创建 `/workflow-ui` 静态资源代理（挂载前缀 `/workflow-ui`）。 */
export function createWorkflowStaticApp(deps: WorkflowRouteDependencies) {
  return new Elysia({ name: "workflow-static", prefix: "/workflow-ui" })
    .use(deps.authGuardPlugin)
    .all("/", ({ request }) => proxyToAcpxG(getWorkflowConfig().acpxGUrl, "", request), {
      sessionAuth: true,
      detail: {
        hide: true,
        tags: ["Workflow Engine"],
        summary: "访问 Workflow UI 代理入口",
        description:
          "将 `/workflow-ui/` 请求透传到内部 `acpx-g` 服务根路径，用于加载工作流前端界面入口。该接口是静态资源代理，具体响应内容取决于下游服务。",
      },
    })
    .all("/:path", ({ params, request }) => proxyToAcpxG(getWorkflowConfig().acpxGUrl, `/${params.path}`, request), {
      sessionAuth: true,
      detail: {
        hide: true,
        tags: ["Workflow Engine"],
        summary: "访问 Workflow UI 代理资源",
        description:
          "将 `/workflow-ui/:path` 请求透传到内部 `acpx-g` 服务对应路径，用于加载工作流页面依赖的脚本、样式和其他静态资源。`:path` 只接受单个路径段（不含 `/`、`.`、`..`），越出挂载前缀的路径返回 400。该接口是透传代理，不在当前文档中展开下游资源结构。",
      },
    });
}
