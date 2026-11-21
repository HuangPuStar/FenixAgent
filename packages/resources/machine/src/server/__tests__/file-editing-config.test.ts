import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { parseMachineEditingConfig } from "../editing/editing-config";

// 未部署文档服务时不影响文本编辑，两个新增变量必须成组配置。
test("office config is optional but rejects partial deployment", () => {
  expect(parseMachineEditingConfig({})).toBeNull();
  expect(() => parseMachineEditingConfig({ publicUrl: "https://docs.example.test" })).toThrow();
  expect(() => parseMachineEditingConfig({ jwtSecret: randomBytes(32).toString("hex") })).toThrow();
});

// Office 仅接收两项新配置，回调复用宿主可信基址且不泄漏密钥。
test("validates service and callback addresses without echoing secret", () => {
  const jwtSecret = randomBytes(32).toString("hex");
  const config = parseMachineEditingConfig({
    publicUrl: "https://docs.example.test/",
    jwtSecret,
    baseUrl: "https://app.example.test/",
  });
  expect(config?.publicUrl).toBe("https://docs.example.test");
  expect(config?.baseUrl).toBe("https://app.example.test");
  expect(() =>
    parseMachineEditingConfig({ publicUrl: "file:///tmp", jwtSecret, baseUrl: "https://app.example.test" }),
  ).toThrow();
  expect(() => parseMachineEditingConfig({ publicUrl: "https://docs.example.test", jwtSecret, baseUrl: "" })).toThrow();
});
