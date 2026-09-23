import { describe, expect, test } from "bun:test";
import { buildYjsUrl, getTerminalYjsWsErrorCode } from "../yjs/yjs-ws";

describe("yjs websocket adapter", () => {
  // 本文件只做项目侧包装：URL 构造依赖浏览器 API，连接/重连/消息解析委托 @fenix/chat-channel。
  test("仅保留 URL 与 transport 适配能力", () => {
    expect(typeof buildYjsUrl).toBe("function");
  });

  // 终态关闭码 → UI 语义。词表本体已收敛到 @fenix/chat-channel 的关闭码策略表
  // （transport/ws-close-codes.ts），这里锁住**改前的逐码判定结果**，防止收敛引入行为变化。
  test("逐码返回 UI 语义错误码", () => {
    expect(getTerminalYjsWsErrorCode(4001)).toBe("instance_idle_reclaimed");
    expect(getTerminalYjsWsErrorCode(4004)).toBe("environment_unavailable");
    expect(getTerminalYjsWsErrorCode(4500)).toBe("machine_unavailable");
    expect(getTerminalYjsWsErrorCode(4501)).toBe("client_keepalive_timeout");
    expect(getTerminalYjsWsErrorCode(4502)).toBe("spawn_rejected");
    // 4503 返回 null 是**已知缺口**（docs/developer/guide/frontend-development.md §8.3/§8.6）：
    // 传输层停重连但 UI 拿不到可展示语义。补语义会让该场景出现新的用户可见提示 = 行为变化，
    // 本测试固定现状，改动此处必须先改文档并单独评估。
    expect(getTerminalYjsWsErrorCode(4503)).toBeNull();
    // 未知码 / 非终态码不产生 UI 语义
    expect(getTerminalYjsWsErrorCode(1000)).toBeNull();
    expect(getTerminalYjsWsErrorCode(1006)).toBeNull();
    expect(getTerminalYjsWsErrorCode(4003)).toBeNull();
  });

  // 1013 的两个语义来源按 close reason 区分；例外只对该码生效。
  test("1013 按关闭原因区分终态与非终态", () => {
    expect(getTerminalYjsWsErrorCode(1013)).toBe("too_many_connections");
    expect(getTerminalYjsWsErrorCode(1013, "unknown reason")).toBe("too_many_connections");
    expect(getTerminalYjsWsErrorCode(1013, "slow consumer resync timeout")).toBeNull();
    // 例外不得扩散：其他终态码即使携带同一 reason 仍按自身语义判定
    expect(getTerminalYjsWsErrorCode(4001, "slow consumer resync timeout")).toBe("instance_idle_reclaimed");
    expect(getTerminalYjsWsErrorCode(4503, "slow consumer resync timeout")).toBeNull();
  });
});
