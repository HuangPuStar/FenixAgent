import { describe, expect, test } from "bun:test";
import { buildYjsUrl } from "../yjs/yjs-ws";

describe("yjs websocket adapter", () => {
  // close code/reason 不提供业务 Type 分类 API。
  test("仅保留 URL 与 transport 适配能力", () => {
    expect(typeof buildYjsUrl).toBe("function");
  });
});
