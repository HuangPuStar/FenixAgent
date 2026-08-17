// packages/chat-channel/src/protocol/update-frame.ts
// yjs:update 二进制 WS 帧编解码（SP-A4，含 B8 慢解码路径治理）。
//
// 线协议：yjs:update 一律走二进制帧，替代历史 {type:"yjs:update",docName,data:base64}
// JSON 文本帧——base64 使传输体积膨胀 ~33%，且客户端 atob + 逐字节回调解码在大快照
// 下是慢路径。其余消息（keep_alive / pong / error / action_ack / action_error）保持
// JSON 文本帧，客户端以 typeof event.data === "string" 判别帧类型。
//
// 帧布局（docNameLen 为大端网络字节序）：
//   [1-byte type=0x01][2-byte docNameLen][docName UTF-8][Yjs update bytes]
//
// 帧类型 0x02 预留给 SP-A5 的 state vector 差量同步帧，二者共用同一布局族。

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** yjs:update 二进制帧类型标识；0x02 已预留给 SP-A5 state vector 帧 */
export const YJS_UPDATE_FRAME_TYPE = 0x01;

/** 解码后的 yjs:update 帧：docName 如 "chat:rcs_xxx"，update 为可直接 Y.applyUpdate 的增量 */
export interface YjsUpdateFrame {
  docName: string;
  update: Uint8Array;
}

/**
 * 编码 yjs:update 二进制帧。
 * docName 超过 65535 字节时抛错（实际 docName 为 `chat:rcs_*` 短标识，属协议不变量违约）。
 */
export function encodeYjsUpdateFrame(docName: string, update: Uint8Array): Uint8Array {
  const docNameBytes = TEXT_ENCODER.encode(docName);
  if (docNameBytes.length > 0xffff) {
    throw new Error(`yjs update frame docName too long: ${docNameBytes.length} bytes`);
  }
  const frame = new Uint8Array(3 + docNameBytes.length + update.length);
  frame[0] = YJS_UPDATE_FRAME_TYPE;
  frame[1] = (docNameBytes.length >> 8) & 0xff;
  frame[2] = docNameBytes.length & 0xff;
  frame.set(docNameBytes, 3);
  frame.set(update, 3 + docNameBytes.length);
  return frame;
}

/**
 * 解码 yjs:update 二进制帧。
 * 帧头类型不符或长度越界返回 null（调用方静默丢弃坏帧，不得让单条坏帧中断连接）；
 * 返回的 update 是输入缓冲的子视图（零拷贝），调用方不得在其底层缓冲被复用后继续持有。
 */
export function decodeYjsUpdateFrame(data: Uint8Array): YjsUpdateFrame | null {
  if (data.length < 3 || data[0] !== YJS_UPDATE_FRAME_TYPE) return null;
  const docNameLen = (data[1] << 8) | data[2];
  if (3 + docNameLen > data.length) return null;
  const docName = TEXT_DECODER.decode(data.subarray(3, 3 + docNameLen));
  return { docName, update: data.subarray(3 + docNameLen) };
}
