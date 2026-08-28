import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import apiWorkflowRoutes from "../routes/api/workflows";
import webRoutes from "../routes/web";

const REFERENCES_DIR = join(process.cwd(), ".agents/skills/agent-platform-api/references");

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
