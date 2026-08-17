// packages/chat-channel/src/persist/snapshot-framing.ts
// Pub/Sub 发布载荷的发布者标识头（SP-A6 自环过滤）。
//
// 载荷布局 [1-byte flag=0x80][16-byte publisherId][4-byte BE payloadLength][update bytes]；
// 本进程发布的消息在本进程 subscriber 处按 publisherId 自环跳过（单进程部署下消息
// 处理量减半），多进程间 publisherId 不同、正常互发。
//
// 帧判定必须与旧格式（无头裸 update）无损区分：裸 update 的首字节是写入方客户端数
// 的 varuint（实测小型 update 即以 0x01 开头），因此 flag 不能取 0x00–0x7F 内的值；
// 取 0x80（首 varuint ≥ 128 个写入客户端才会出现，本系统不可能）并叠加
// payloadLength 自校验（须精确等于剩余字节数），双重约束下误判概率可忽略。
// 极端误判的后果仅为：一条旧格式消息被错位 apply、因 yjs 校验失败被丢弃——只在
// 前后版本混布的瞬时滚动窗口内可能发生，快照 CAS 路径仍保证最终收敛。

import { randomUUID } from "node:crypto";

const PUBLISH_FRAME_FLAG = 0x80;
const PUBLISHER_ID_BYTES = 16;
const PUBLISH_PAYLOAD_LENGTH_BYTES = 4;
const PUBLISH_HEADER_LENGTH = 1 + PUBLISHER_ID_BYTES + PUBLISH_PAYLOAD_LENGTH_BYTES;

/** 进程级 publisherId：模块初始化生成，同进程所有 provider 共享。 */
export const PUBLISHER_ID = createPublisherId(randomUUID());

/** 由 UUID 字符串派生 16 字节发布者标识。 */
export function createPublisherId(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(PUBLISHER_ID_BYTES);
  for (let index = 0; index < PUBLISHER_ID_BYTES; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function isSamePublisherId(a: Uint8Array, b: Uint8Array): boolean {
  for (let index = 0; index < PUBLISHER_ID_BYTES; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** 为 update 附加发布者标识头（含长度自校验字段）。 */
export function framePublishUpdate(update: Uint8Array, publisherId: Uint8Array): Buffer {
  const framed = Buffer.alloc(PUBLISH_HEADER_LENGTH + update.length);
  framed[0] = PUBLISH_FRAME_FLAG;
  framed.set(publisherId, 1);
  framed.writeUInt32BE(update.length, 1 + PUBLISHER_ID_BYTES);
  framed.set(update, PUBLISH_HEADER_LENGTH);
  return framed;
}

/**
 * 识别带头部的发布载荷；旧格式（无头裸 update）或长度校验不符返回 null，
 * 由调用方回落按原始 update 全量 apply（滚动部署期无损兼容）。
 */
export function parseFramedPublish(payload: Uint8Array): { publisherId: Uint8Array; update: Uint8Array } | null {
  if (payload.length < PUBLISH_HEADER_LENGTH || payload[0] !== PUBLISH_FRAME_FLAG) return null;

  const lengthOffset = 1 + PUBLISHER_ID_BYTES;
  const payloadLength =
    ((payload[lengthOffset] << 24) |
      (payload[lengthOffset + 1] << 16) |
      (payload[lengthOffset + 2] << 8) |
      payload[lengthOffset + 3]) >>>
    0;
  if (payloadLength !== payload.length - PUBLISH_HEADER_LENGTH) return null;

  return {
    publisherId: payload.subarray(1, lengthOffset),
    update: payload.subarray(PUBLISH_HEADER_LENGTH),
  };
}
