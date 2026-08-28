import { describe, expect, test } from "bun:test";
import { resolveChatAuthState } from "../pages/agent-panel/chat-auth-state";

describe("resolveChatAuthState", () => {
  // useSession 请求进行中（首次加载）：必须等待登录态就绪，展示加载态而非"连接中"
  test("returns loading while the session request is pending", () => {
    expect(resolveChatAuthState({ pending: true, error: null, userId: undefined })).toBe("loading");
    expect(resolveChatAuthState({ pending: true, error: null, userId: "user-1" })).toBe("loading");
  });

  // 请求成功且用户已登录：允许建连
  test("returns ready when a user is resolved", () => {
    expect(resolveChatAuthState({ pending: false, error: null, userId: "user-1" })).toBe("ready");
  });

  // 请求失败（网络/服务端异常）：明确失败态，提供重试出口，杜绝永转圈
  test("returns failed when the session request errors", () => {
    expect(resolveChatAuthState({ pending: false, error: new Error("network"), userId: undefined })).toBe("failed");
  });

  // 请求完成但无用户（未登录/会话失效）：同样视为失败态而非永驻加载
  test("returns failed when no user is resolved after the request settles", () => {
    expect(resolveChatAuthState({ pending: false, error: null, userId: undefined })).toBe("failed");
  });
});
