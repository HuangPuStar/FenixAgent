import { describe, expect, test } from "bun:test";
import { getModelGatewayConnectionFeedback } from "../pages/admin/model-gateway-feedback";

describe("model gateway connection feedback", () => {
  // 验证可访问的网关显示成功反馈和发现的模型数量。
  test("returns a success message for a reachable gateway", () => {
    expect(getModelGatewayConnectionFeedback({ status: "synced", models: [{}, {}] })).toEqual({
      level: "success",
      translationKey: "modelGateway.connectionCheck.succeeded",
      values: { count: 2 },
    });
  });

  // 验证适配器已返回 unknown 时仍显示连接失败，而非静默刷新状态。
  test("returns an error message for an unavailable gateway", () => {
    expect(getModelGatewayConnectionFeedback({ status: "unknown", error: "LiteLLM unavailable" })).toEqual({
      level: "error",
      translationKey: "modelGateway.connectionCheck.failed",
      values: { message: "LiteLLM unavailable" },
    });
  });
});
