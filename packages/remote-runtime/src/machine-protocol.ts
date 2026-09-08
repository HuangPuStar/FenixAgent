/** Machine lifecycle 协议版本；缺失或不同版本必须拒绝连接。 */
export const MACHINE_PROTOCOL_VERSION = 2;

/** 主服务进程 epoch。每次模块装载（服务启动）生成一次，禁止跨重启复用。 */
export const SERVER_EPOCH = crypto.randomUUID();

/** generation/epoch fencing 字段。 */
export interface RuntimeFence {
  instance_uid: string;
  runtime_generation: number;
  server_epoch: string;
}

/** 校验不可信 Machine 消息是否携带当前 fence。 */
export function hasRuntimeFence(
  message: Record<string, unknown>,
  expected: { instanceUid: string; runtimeGeneration: number; serverEpoch: string },
): boolean {
  return (
    message.instance_uid === expected.instanceUid &&
    message.runtime_generation === expected.runtimeGeneration &&
    message.server_epoch === expected.serverEpoch
  );
}
