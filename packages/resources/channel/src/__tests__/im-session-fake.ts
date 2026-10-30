import type {
  ImSessionHandle,
  ImSessionInstanceInput,
  ImSessionInstanceRef,
  ImSessionOpenPortInput,
  ImSessionPort,
  ImWakePromptInput,
} from "../server/ports/im-session";

/**
 * 冷启动桥接的假端口。
 *
 * 只记录调用与返回，不模拟 ACP：桥接层的错误分类、暖态作废与单飞语义都能在没有运行时的情况下验证。
 * 失败注入是「一次性」的——下一次调用恢复成功，用来断言失败没有污染后续冷启动。
 */

export interface FakeImSessionPortCalls {
  ensureInstance: number;
  openSession: number;
  sendWakePrompt: number;
  close: number;
}

export interface FakeImSessionPort extends ImSessionPort {
  readonly calls: FakeImSessionPortCalls;
  readonly instanceInputs: ImSessionInstanceInput[];
  readonly openInputs: ImSessionOpenPortInput[];
  readonly wakePrompts: string[];
  /** 模拟实例重启：实例 uid 不变，运行代次变化。 */
  rebuildRuntime(): void;
  /** 模拟实例被替换：实例 uid 与运行代次同时变化。 */
  replaceInstance(): void;
  failNextEnsure(error: Error): void;
  failNextOpen(error: Error): void;
  failNextWake(error: Error): void;
}

export function createFakeImSessionPort(): FakeImSessionPort {
  const calls: FakeImSessionPortCalls = { ensureInstance: 0, openSession: 0, sendWakePrompt: 0, close: 0 };
  const instanceInputs: ImSessionInstanceInput[] = [];
  const openInputs: ImSessionOpenPortInput[] = [];
  const wakePrompts: string[] = [];

  let instanceId = "instance-1";
  let runtimeGeneration = 1;
  let sessionSeq = 0;
  let ensureError: Error | null = null;
  let openError: Error | null = null;
  let wakeError: Error | null = null;

  return {
    calls,
    instanceInputs,
    openInputs,
    wakePrompts,

    async ensureInstance(input: ImSessionInstanceInput): Promise<ImSessionInstanceRef> {
      calls.ensureInstance += 1;
      instanceInputs.push(input);
      if (ensureError) {
        const error = ensureError;
        ensureError = null;
        throw error;
      }
      return { instanceId, runtimeToken: `generation-${runtimeGeneration}` };
    },

    async openSession(input: ImSessionOpenPortInput): Promise<ImSessionHandle> {
      calls.openSession += 1;
      openInputs.push(input);
      if (openError) {
        const error = openError;
        openError = null;
        throw error;
      }
      sessionSeq += 1;
      return {
        handleId: `handle-${sessionSeq}`,
        conversationId: input.target.conversationId,
        instanceId: input.instance.instanceId,
        acpSessionId: `ses_fake_${sessionSeq}`,
      };
    },

    async sendWakePrompt(input: ImWakePromptInput): Promise<void> {
      calls.sendWakePrompt += 1;
      wakePrompts.push(input.text);
      if (wakeError) {
        const error = wakeError;
        wakeError = null;
        throw error;
      }
    },

    async close(): Promise<void> {
      calls.close += 1;
    },

    rebuildRuntime(): void {
      runtimeGeneration += 1;
    },

    replaceInstance(): void {
      instanceId = `instance-${runtimeGeneration + 1}`;
      runtimeGeneration += 1;
    },

    failNextEnsure(error: Error): void {
      ensureError = error;
    },

    failNextOpen(error: Error): void {
      openError = error;
    },

    failNextWake(error: Error): void {
      wakeError = error;
    },
  };
}
