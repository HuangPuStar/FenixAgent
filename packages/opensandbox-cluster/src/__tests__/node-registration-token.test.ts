import { describe, expect, test } from "bun:test";
import {
  createNodeRegistrationToken,
  parseNodeRegistrationToken,
  verifyNodeRegistrationToken,
} from "../security/node-registration-token";

describe("node registration token", () => {
  // token 可解析出 server scope，验证只依赖哈希且篡改会失败。
  test("generates and verifies a scoped node token", () => {
    const token = createNodeRegistrationToken("server-a");
    expect(parseNodeRegistrationToken(token.value)?.serverId).toBe("server-a");
    expect(verifyNodeRegistrationToken(token.value, token.hash)).toBe(true);
    expect(verifyNodeRegistrationToken(`${token.value}x`, token.hash)).toBe(false);
  });

  // token secret 每次随机生成，避免重复注册凭证。
  test("generates distinct values", () => {
    expect(createNodeRegistrationToken("server-a").value).not.toBe(createNodeRegistrationToken("server-a").value);
  });
});
