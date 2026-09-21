import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApiWorkflowRoutes } from "@fenix/resource-workflow/server";
import { authGuardPlugin } from "../plugins/auth";
import { createWebApp } from "../routes/web";
import { createTestWebConfigRoutes } from "../test-utils/web-config-routes";

const REFERENCES_DIR = join(process.cwd(), ".agents/skills/agent-platform-api/references");

// 资源包路由是工厂（守卫由宿主注入，Elysia 的 macro / state 是实例作用域的），用例按宿主装配的
// 同一形状构造一份，只读它的 route 表做路径比对。
const apiWorkflowRoutes = createApiWorkflowRoutes({ authGuardPlugin });
// `/web` 聚合同样是工厂：1.5e 起路由贡献由装配期登记（`bootstrap/route-contributions`）。本用例检查
// 「文档示例指向真实注册的路由」，因此要喂入各包的真实路由——`web` 槽仍传空数组（文档示例不覆盖那里已
// 迁入贡献面的端点），`webConfig` 槽用 test-utils 的同入口集合（不跑装配的理由见该 helper 文件头）。
const webRoutes = createWebApp({ web: [], webConfig: createTestWebConfigRoutes() });

interface DocumentedRequest {
  file: string;
  line: number;
  method: string;
  path: string;
}

/** 提取 references 中直接请求平台 Web/API 路由的 curl 命令。 */
function collectDocumentedRequests(): DocumentedRequest[] {
  const requests: DocumentedRequest[] = [];
  for (const file of readdirSync(REFERENCES_DIR).filter((name) => name.endsWith(".md"))) {
    const lines = readFileSync(join(REFERENCES_DIR, file), "utf8").split("\n");
    const variables = new Map<string, string>([["USER_META_BASE_URL", ""]]);
    lines.forEach((line, index) => {
      const assignment = line.match(/^([A-Z][A-Z0-9_]*)=["']([^"']+)["']$/);
      if (assignment) {
        variables.set(assignment[1], expandVariables(assignment[2], variables));
        return;
      }
      if (!line.includes("curl ")) return;
      const expandedLine = expandVariables(line, variables);
      const pathMatch = expandedLine.match(/(?:^|[\s"'])((?:\/web|\/api)[^"'\s]*)/);
      if (!pathMatch) return;
      const method = line.match(/(?:^|\s)-X\s+([A-Za-z]+)/)?.[1]?.toUpperCase() ?? "GET";
      requests.push({
        file,
        line: index + 1,
        method,
        path: pathMatch[1].split("?")[0].replace(/\/$/, ""),
      });
    });
  }
  return requests;
}

/** 展开示例中用于拼接平台地址的 shell 变量。 */
function expandVariables(value: string, variables: Map<string, string>): string {
  return value.replace(/\$\{?([A-Z][A-Z0-9_]*)\}?/g, (match, name: string) => variables.get(name) ?? match);
}

/** 将文档占位符与 Elysia 路径参数统一成可比较的分段形式。 */
function pathMatches(documentedPath: string, routePath: string): boolean {
  const documentedSegments = documentedPath.split("/").filter(Boolean);
  const routeSegments = routePath.replace(/\/$/, "").split("/").filter(Boolean);
  const hasWildcard = routeSegments.at(-1) === "*";
  if (hasWildcard) routeSegments.pop();
  if (
    hasWildcard ? documentedSegments.length < routeSegments.length : documentedSegments.length !== routeSegments.length
  )
    return false;
  return routeSegments.every((routeSegment, index) => {
    const segment = documentedSegments[index];
    const isDocumentedPlaceholder = /^<[^>]+>$/.test(segment) || /^\$\{?[A-Z0-9_]+\}?$/.test(segment);
    return isDocumentedPlaceholder || routeSegment.startsWith(":") || segment === routeSegment;
  });
}

describe("agent-platform-api references", () => {
  // 文档中的平台 curl 示例必须指向当前真实注册的 HTTP method 与 route。
  test("all documented platform routes exist", () => {
    const actualRoutes = [...webRoutes.routes, ...apiWorkflowRoutes.routes].flatMap((route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      return methods.map((method) => ({ method, path: route.path }));
    });
    const missing = collectDocumentedRequests().filter(
      (request) =>
        !actualRoutes.some(
          (route) =>
            (route.method === "ALL" || route.method === request.method) && pathMatches(request.path, route.path),
        ),
    );

    expect(missing).toEqual([]);
  });
});
