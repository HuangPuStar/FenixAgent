// packages/chat-channel/src/__tests__/update-frame.test.ts
// Yjs 同步帧的二进制协议测试：兼容 legacy update，并拒绝损坏或越界的 v2 帧。

import { describe, expect, test } from "bun:test";
import {
  decodeYjsSyncFrame,
  decodeYjsUpdateFrame,
  encodeYjsReplaceFrame,
  encodeYjsStateVectorFrame,
  encodeYjsUpdateFrame,
  MAX_YJS_IDENTIFIER_BYTES,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
  YJS_FRAME_VERSION,
  YJS_REPLACE_FRAME_TYPE,
  YJS_STATE_VECTOR_FRAME_TYPE,
  YJS_UPDATE_FRAME_TYPE,
  YJS_V2_MAGIC,
  YJS_V2_MAGIC_SECOND,
} from "../protocol/update-frame";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("Yjs 同步帧编解码", () => {
  // 兼容性：legacy update 帧保留文档名与原始二进制更新内容
  test("decodes legacy update frames", () => {
    const update = bytes(1, 2, 3);
    const decoded = decodeYjsSyncFrame(encodeYjsUpdateFrame("chat:会话", update));

    expect(decoded).toEqual({ type: "legacy-update", docName: "chat:会话", generation: null, update });
    expect(decodeYjsUpdateFrame(encodeYjsUpdateFrame("chat:会话", update))).toEqual({ docName: "chat:会话", update });
  });

  // 同步：v2 update 帧携带 generation，避免跨世代更新被错误应用
  test("round trips generation-aware update frames", () => {
    const update = bytes(9, 8, 7);

    expect(decodeYjsSyncFrame(encodeYjsUpdateFrame("chat:rcs_1", "generation_1", update))).toEqual({
      type: "update",
      docName: "chat:rcs_1",
      generation: "generation_1",
      update,
    });
  });

  // 同步协商：state vector 帧使用独立类型并保留其 payload
  test("round trips state-vector frames", () => {
    const stateVector = bytes(4, 5, 6);

    expect(decodeYjsSyncFrame(encodeYjsStateVectorFrame("session:rcs_1", "generation_1", stateVector))).toEqual({
      type: "state-vector",
      docName: "session:rcs_1",
      generation: "generation_1",
      stateVector,
    });
  });

  // 全量恢复：replace 帧使用独立类型，不能被 update 专用解码器接受
  test("round trips replace frames without treating them as updates", () => {
    const update = bytes(6, 5, 4);
    const frame = encodeYjsReplaceFrame("session:rcs_1", "generation_1", update);

    expect(decodeYjsSyncFrame(frame)).toEqual({
      type: "replace",
      docName: "session:rcs_1",
      generation: "generation_1",
      update,
    });
    expect(decodeYjsUpdateFrame(frame)).toBeNull();
  });

  // 输入校验：编码阶段拒绝空标识、超长标识与超出同步上限的 payload
  test("rejects invalid identifiers and oversized payloads while encoding", () => {
    expect(() => encodeYjsUpdateFrame("", bytes(1))).toThrow("docName length is invalid");
    expect(() => encodeYjsUpdateFrame("chat:rcs_1", "", bytes(1))).toThrow("generation length is invalid");
    expect(() => encodeYjsUpdateFrame("x".repeat(MAX_YJS_IDENTIFIER_BYTES + 1), bytes(1))).toThrow(
      "docName length is invalid",
    );
    expect(() =>
      encodeYjsUpdateFrame("chat:rcs_1", "generation_1", new Uint8Array(MAX_YJS_SYNC_PAYLOAD_BYTES + 1)),
    ).toThrow("Yjs payload too large");
  });

  // 协议安全：未知类型、过短帧及伪造的 v2 magic 前缀均不得降级为 legacy
  test("rejects unsupported, truncated, and incomplete v2 frames", () => {
    expect(decodeYjsSyncFrame(bytes())).toBeNull();
    expect(decodeYjsSyncFrame(bytes(0xff, 0, 0))).toBeNull();
    expect(decodeYjsSyncFrame(bytes(YJS_STATE_VECTOR_FRAME_TYPE, 0, 1, 97))).toBeNull();
    expect(decodeYjsSyncFrame(bytes(YJS_UPDATE_FRAME_TYPE, YJS_V2_MAGIC, 0, 1))).toBeNull();
    expect(decodeYjsSyncFrame(bytes(YJS_UPDATE_FRAME_TYPE, YJS_V2_MAGIC, YJS_V2_MAGIC_SECOND, 1))).toBeNull();
  });

  // 协议安全：v2 头部中的空文档、空世代或截断长度不得产生可用同步事件
  test("rejects malformed v2 identifier lengths", () => {
    const header = [YJS_UPDATE_FRAME_TYPE, YJS_V2_MAGIC, YJS_V2_MAGIC_SECOND, YJS_FRAME_VERSION];

    expect(decodeYjsSyncFrame(bytes(...header, 0, 0, 0, 0))).toBeNull();
    expect(decodeYjsSyncFrame(bytes(...header, 0, 2, 97, 0, 0))).toBeNull();
    expect(decodeYjsSyncFrame(bytes(...header, 0, 1, 97, 0, 2, 98))).toBeNull();
  });

  // 协议安全：UTF-8 非法标识必须被拒绝，防止不可寻址的文档或世代进入状态层
  test("rejects frames with invalid UTF-8 identifiers", () => {
    expect(decodeYjsSyncFrame(bytes(YJS_UPDATE_FRAME_TYPE, 0, 1, 0xff))).toBeNull();
    expect(
      decodeYjsSyncFrame(
        bytes(YJS_REPLACE_FRAME_TYPE, YJS_V2_MAGIC, YJS_V2_MAGIC_SECOND, YJS_FRAME_VERSION, 0, 1, 97, 0, 1, 0xff),
      ),
    ).toBeNull();
  });
});
