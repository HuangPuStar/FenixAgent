/** 第一处持有入站消息时准入；普通消息与取消命令各有独立的受控容量。 */
export const INBOUND_MESSAGE_LIMITS = {
  connection: { count: 64, bytes: 16 * 1024 * 1024 },
  user: { count: 256, bytes: 32 * 1024 * 1024 },
  service: { count: 2048, bytes: 128 * 1024 * 1024 },
  control: { count: 2, bytes: 64 * 1024 },
} as const;

type Payload = string | Uint8Array;
interface Usage {
  count: number;
  bytes: number;
}
interface Item {
  payload: Payload;
  bytes: number;
  control: boolean;
}
const serviceUsage: Usage = { count: 0, bytes: 0 };
const userUsage = new Map<string, Usage>();

function adjust(usage: Usage, bytes: number, count: number): void {
  usage.count += count;
  usage.bytes += bytes;
}

/** 只识别小尺寸取消/停止控制帧，不让大输入占用终止操作的保留容量。 */
export function isInboundControlMessage(payload: Payload): boolean {
  if (typeof payload !== "string" || Buffer.byteLength(payload) > INBOUND_MESSAGE_LIMITS.control.bytes) return false;
  try {
    const message = JSON.parse(payload) as { action?: string; type?: string };
    return message?.action === "cancel" || message?.action === "stop" || message?.type === "cancel";
  } catch {
    return false;
  }
}

/** 有界串行入站队列；关闭时丢弃未执行消息，已执行任务继续占用预算直到结算。 */
export class InboundMessageQueue {
  private owner: string;
  private pending: Item[] = [];
  private usage: Usage = { count: 0, bytes: 0 };
  private controls: Usage = { count: 0, bytes: 0 };
  private closed = false;
  private running = false;
  private handling?: (payload: Payload) => Promise<void>;

  constructor(
    owner: string,
    private readonly onOverflow: () => void,
    private readonly onError: (error: unknown) => void,
  ) {
    this.owner = owner;
  }

  /** 认证前消息也受服务预算约束；认证后将已有预算计入该用户。 */
  bindOwner(owner: string): boolean {
    if (this.closed) return false;
    if (owner === this.owner) return true;
    const next = userUsage.get(owner) ?? { count: 0, bytes: 0 };
    if (
      next.count + this.usage.count > INBOUND_MESSAGE_LIMITS.user.count ||
      next.bytes + this.usage.bytes > INBOUND_MESSAGE_LIMITS.user.bytes
    ) {
      this.onOverflow();
      this.close();
      return false;
    }
    this.adjustUser(-this.usage.bytes, -this.usage.count);
    this.owner = owner;
    this.adjustUser(this.usage.bytes, this.usage.count);
    return true;
  }

  /** 授权完成后开始分派；握手与业务就绪由下游各自校验，避免握手等待本队列。 */
  start(handling: (payload: Payload) => Promise<void>): void {
    if (this.closed) return;
    this.handling = handling;
    const controls = this.pending.filter((item) => item.control);
    this.pending = this.pending.filter((item) => !item.control);
    for (const item of controls) void this.execute(item);
    void this.drain();
  }

  /** 首个 await 之前同步占用数量与 UTF-8 字节预算。 */
  enqueue(payload: Payload): boolean {
    if (this.closed) return false;
    const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
    const control = isInboundControlMessage(payload);
    const user = userUsage.get(this.owner) ?? { count: 0, bytes: 0 };
    const fits = control
      ? this.controls.count < INBOUND_MESSAGE_LIMITS.control.count &&
        this.controls.bytes + bytes <= INBOUND_MESSAGE_LIMITS.control.bytes
      : this.usage.count - this.controls.count < INBOUND_MESSAGE_LIMITS.connection.count &&
        this.usage.bytes - this.controls.bytes + bytes <= INBOUND_MESSAGE_LIMITS.connection.bytes;
    const reserve = control ? INBOUND_MESSAGE_LIMITS.control : { count: 0, bytes: 0 };
    if (
      !fits ||
      user.count + 1 > INBOUND_MESSAGE_LIMITS.user.count + reserve.count ||
      user.bytes + bytes > INBOUND_MESSAGE_LIMITS.user.bytes + reserve.bytes ||
      serviceUsage.count + 1 > INBOUND_MESSAGE_LIMITS.service.count + reserve.count ||
      serviceUsage.bytes + bytes > INBOUND_MESSAGE_LIMITS.service.bytes + reserve.bytes
    ) {
      this.onOverflow();
      this.close();
      return false;
    }
    const item = { payload, bytes, control };
    adjust(this.usage, bytes, 1);
    adjust(serviceUsage, bytes, 1);
    this.adjustUser(bytes, 1);
    if (control) adjust(this.controls, bytes, 1);
    // 已握手的取消命令不等待慢 load/create 的普通消息链。
    if (control && this.handling) void this.execute(item);
    else {
      this.pending.push(item);
      void this.drain();
    }
    return true;
  }

  /** 主动释放所有未执行消息，执行中的回调不能再开启后续排队任务。 */
  close(): void {
    this.closed = true;
    for (const item of this.pending.splice(0)) this.release(item);
  }

  /** 观测累计暂存（含在途），避免只看下游命令队列掩盖前置积压。 */
  snapshot(): Readonly<Usage> {
    return { ...this.usage };
  }

  private adjustUser(bytes: number, count: number): void {
    const usage = userUsage.get(this.owner) ?? { count: 0, bytes: 0 };
    adjust(usage, bytes, count);
    if (usage.count === 0) userUsage.delete(this.owner);
    else userUsage.set(this.owner, usage);
  }

  private release(item: Item): void {
    adjust(this.usage, -item.bytes, -1);
    adjust(serviceUsage, -item.bytes, -1);
    this.adjustUser(-item.bytes, -1);
    if (item.control) adjust(this.controls, -item.bytes, -1);
  }

  private async execute(item: Item): Promise<void> {
    try {
      await this.handling?.(item.payload);
    } catch (error) {
      this.onError(error);
    } finally {
      this.release(item);
    }
  }

  private async drain(): Promise<void> {
    if (this.running || this.closed || !this.handling) return;
    this.running = true;
    try {
      while (!this.closed && this.pending.length > 0) {
        const item = this.pending.shift();
        if (item) await this.execute(item);
      }
    } finally {
      this.running = false;
    }
  }
}
