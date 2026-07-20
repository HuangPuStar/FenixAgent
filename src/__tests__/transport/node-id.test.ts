import { describe, expect, test } from "bun:test";
import { NODE_ID } from "../../transport/store/node-id";

describe("NODE_ID", () => {
  // NODE_ID 前缀为 rcs_
  test("以 rcs_ 为前缀", () => {
    expect(NODE_ID.startsWith("rcs_")).toBe(true);
  });

  // NODE_ID 为 36 字符（rcs_ + 32位 UUID 去横线）
  test("长度为 36 字符", () => {
    expect(NODE_ID.length).toBe(36);
  });

  // NODE_ID 仅包含十六进制字符 + "rcs_"
  test("仅包含十六进制字符和 rcs_ 前缀", () => {
    const hexPart = NODE_ID.slice(4);
    expect(/^[0-9a-f]+$/.test(hexPart)).toBe(true);
  });
});
