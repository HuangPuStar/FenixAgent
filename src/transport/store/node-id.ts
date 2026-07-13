import { randomUUID } from "node:crypto";

/**
 * 当前 RCS 节点的唯一标识符。
 *
 * 用于 EventBus 跨节点广播时的消息去重——每个事件都携带 _nodeId，
 * 节点的 subscribe 消费端会自动跳过自己发出的消息，避免双重投递。
 */
export const NODE_ID = `rcs_${randomUUID().replace(/-/g, "")}`;
