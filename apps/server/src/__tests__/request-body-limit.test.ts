// 宿主请求体上限的边界回归（AOS-BUG-005）。
//
// 现场：前端按 100×1024×1024 放行 100MB 的文件，宿主上限与「单文件上限」取同一个数，于是
// 104,857,599 字节的文件加 multipart 框架开销后超过上限，在宿主层被 413 拦下（
// `{"error":{"type":"PAYLOAD_TOO_LARGE","message":"Request body exceeds 100MB limit"}}`），
// 永远到不了文件门面的按文件校验。本文件钉住三件事：恰好 100MB 的文件必须放行；只有真的超过宿主
// 预算才拒绝；机器包的单文件上限变了以后这里必须同步。
//
// 不真发 100MB 请求体：Bun 允许在构造的 Request 上显式给 `content-length`（守卫只读这个头），
// 因此边界用例用头部即表达完整请求体长度。

import { describe, expect, test } from "bun:test";
import { LOCAL_UPLOAD_MAX_BYTES } from "@fenix/resource-machine/server";
import Elysia from "elysia";
import { bodyLimitPlugin, isRequestBodyOverLimit, MAX_REQUEST_BODY_BYTES } from "../plugins/body-limit";

/** 只装守卫与被守卫路由的最小应用：验证插件接线，不惊动真实聚合路由。 */
function buildApp() {
  return new Elysia().use(bodyLimitPlugin).post("/upload", () => ({ ok: true }));
}

/** 造一个只带 `content-length` 头的 POST 请求（守卫只读这个头）。 */
function postWithContentLength(contentLength: string) {
  return new Request("http://localhost/upload", { method: "POST", headers: { "content-length": contentLength } });
}

describe("宿主请求体守卫", () => {
  // 机器包的单文件上限与宿主体预算必须留有框架开销差：取等号就是 AOS-BUG-005（100MB 文件被误拒）。
  test("宿主上限必须大于机器包的单文件上限", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(LOCAL_UPLOAD_MAX_BYTES);
  });

  // 恰好 100MB 的文件、以及它加上 multipart 框架开销后的请求体，都必须放行——这是报告里失败的那一档。
  test("恰好 100MB 的文件及其 multipart 开销不触发上限", () => {
    expect(isRequestBodyOverLimit(String(LOCAL_UPLOAD_MAX_BYTES))).toBe(false);
    expect(isRequestBodyOverLimit(String(LOCAL_UPLOAD_MAX_BYTES + 512))).toBe(false);
    expect(isRequestBodyOverLimit(String(MAX_REQUEST_BODY_BYTES))).toBe(false);
  });

  // 超过宿主预算一个字节即拒绝，兜底性质不能因为放宽而消失。
  test("超过宿主预算才拒绝", () => {
    expect(isRequestBodyOverLimit(String(MAX_REQUEST_BODY_BYTES + 1))).toBe(true);
  });

  // 缺头（chunked）与畸形值都拿不到可信长度，放行交由 Bun 自身上限与下游 route 兜底，不能误伤。
  test("缺失或非数值的 content-length 不拦截", () => {
    expect(isRequestBodyOverLimit(null)).toBe(false);
    expect(isRequestBodyOverLimit("")).toBe(false);
    expect(isRequestBodyOverLimit("not-a-number")).toBe(false);
  });

  // 插件接线：超限请求在进入被守卫路由前就返回 413 信封，路由处理器不得被执行。
  test("超限请求由插件返回 413，不进入下游路由", async () => {
    const response = await buildApp().handle(postWithContentLength(String(MAX_REQUEST_BODY_BYTES + 1)));

    expect(response.status).toBe(413);
    // `handle` 的返回类型把 `json()` 推成 Elysia 推导的响应体联合（这里是 undefined），按实际契约收窄。
    const body = (await response.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("PAYLOAD_TOO_LARGE");
  });

  // 上限内的请求正常落到路由，守卫不改变正常路径的响应。
  test("上限内的请求正常到达路由", async () => {
    const response = await buildApp().handle(postWithContentLength(String(LOCAL_UPLOAD_MAX_BYTES + 512)));

    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({ ok: true });
  });
});
