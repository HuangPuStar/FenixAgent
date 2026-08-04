import { ACPAgent } from "@acp-agent/core";

type TurnResult = Record<string, any> | void;
type ACPTurnScope = (instance: ACPAgent) => Promise<TurnResult>;

class LifecycleManager {
  private static instance: LifecycleManager;
  constructor() {}
  public static getInstance(): LifecycleManager {
    if (!LifecycleManager.instance) {
      LifecycleManager.instance = new LifecycleManager();
    }
    return LifecycleManager.instance;
  }
  /** 反向注入的生命周期管理器 */
  async runInInstance(fn: ACPTurnScope) {
    // 模拟启动一个实例, 这个异步结束之后， 清理生命周期
  }
}

class ACPAgent extends LifecycleManager {
  cwd: string = process.cwd();
  args: string[];
  model: string = "sonnet";
  constructor(options: { cwd: string; args: string[]; model?: string }) {
    super();
    this.cwd = options.cwd;
    this.args = options.args;
    options.model && (this.model = options.model);
  }
  async createNewSession() {
    // 模拟创建一个新的会话
  }
  /** 这个函数执行完成是发送被接收，而不是发送后等待响应 */
  async sendPrompt(prompt: string) {
    // 模拟发送一个提示
  }
  async *streamMessages() {
    // 模拟流式消息
    yield "这是第一条消息";
    yield "这是第二条消息";
    yield "这是第三条消息";
  }
  async waitForAllDone() {
    // 模拟等待所有任务完成
  }
}

const agent = new ACPAgent({
  cwd: process.cwd(),
  args: ["peri", "acp"],
});

agent.runInInstance(async (instance) => {
  await instance.createNewSession();
  await instance.sendPrompt("你是谁？");
  for await (const message of instance.streamMessages()) {
    console.log(message);
  }
});
