import { describe, expect, test } from "bun:test";
import { readJson } from "@fenix/platform-sdk/testing";
import knowledgeMcpRoutes from "../server/routes/mcp/knowledge";

/**
 * `/mcp/knowledge` 的鉴权拒绝路径。
 *
 * 该入口是整包唯一的模块级单例路由（Bearer environment secret 自鉴权，见路由文件注释），此前
 * 没有任何用例覆盖它的 401 分支——包括宿主侧（`apps/server/src/__tests__` 无该端点的用例）。
 * 本次把错误体从宿主 `errorResponse` 装饰器改为平台统一信封（`ApiErrorResponseSchema`），
 * 因此这里钉住新形状，避免协议面在无测试的情况下漂移。
 *
 * 只覆盖「缺 token」两条分支：需要 token 但格式/内容无效（`Invalid bearer token`）的分支要经
 * `getEnvironmentBySecret` 查库，属宿主基础设施范围，不在本包用例内复刻（README「已知项」记录）。
 */

/** 直接向单例路由发起请求；路径与宿主挂载点一致（`/mcp/knowledge` 无前缀）。 */
function request(headers: Record<string, string> = {}) {
  return knowledgeMcpRoutes.handle(new Request("http://localhost/mcp/knowledge", { method: "POST", headers }));
}

describe("mcp knowledge 入口鉴权", () => {
  // 头缺失由请求头 schema 拦下（422），不会进入处理器：该端点的鉴权输入是头，不是可选参数。
  // 这是既有行为（与错误信封改造无关），用例只钉住它，不做语义变更。
  test("缺少 authorization 头时被请求头 schema 拦下（422）", async () => {
    expect((await request()).status).toBe(422);
  });

  // `Bearer` 后只有空白等同缺 token：不能把空串当作 secret 去查 environment。
  test("Bearer 后只有空白视为缺少 token，返回 401 与平台错误信封", async () => {
    const response = await request({ authorization: "Bearer   " });

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      error: { code: "UNAUTHORIZED", message: "Missing bearer token" },
    });
  });
});
