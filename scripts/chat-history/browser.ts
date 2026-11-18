/** agent-browser CLI 封装；脚本和认证信息走 stdin，不进入命令行或报告。 */
export class BenchmarkBrowser {
  constructor(readonly session: string) {}

  /** 执行浏览器操作，失败仅暴露操作类别，避免 CLI 回显输入脚本中的凭据。 */
  async run(args: readonly string[], input?: string): Promise<Record<string, unknown>> {
    const child = Bun.spawn(["agent-browser", "--session", this.session, "--json", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      const [out] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if ((await child.exited) !== 0) throw new Error(`agent-browser ${args[0]} failed`);
      const result = JSON.parse(out) as { success: boolean; data?: Record<string, unknown> };
      if (!result.success || !result.data) throw new Error(`agent-browser ${args[0]} rejected`);
      return result.data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 页面脚本仅用于观测和触发既有 UI 回调，不给产品添加测试出口。 */
  async evaluate(expression: string): Promise<unknown> {
    return (await this.run(["eval", "--stdin"], expression)).result;
  }

  /** 沿真实登录表单提交，只从受限本地文件读取认证输入。 */
  async login(authFile: string): Promise<void> {
    // 未登录时路由可暂留在 agent，须确认真实 session，不能把延迟跳转当作登录成功。
    const authenticated = await this.evaluate(`fetch('/api/auth/get-session', {signal: AbortSignal.timeout(5000)})
      .then(response => { if (!response.ok) throw new Error('Session verification failed'); return response.json(); })
      .then(data => !!data?.session && !!data?.user)`);
    if (authenticated === true) return;
    await this.run(["wait", "--fn", "!!document.querySelector('input[type=email]')"]);
    const credentials = (await Bun.file(authFile).json()) as { email: string; password: string };
    if (typeof credentials.email !== "string" || typeof credentials.password !== "string")
      throw new Error("Invalid authentication file");
    const submitted = await this.evaluate(`(() => {
      const credentials = ${JSON.stringify(credentials)};
      const email = document.querySelector('input[type=email]');
      if (!email) return false;
      const set = (selector, value) => {
        const input = document.querySelector(selector);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', {bubbles:true}));
        input.dispatchEvent(new Event('change', {bubbles:true}));
      };
      set('input[type=email]', credentials.email);
      set('input[type=password]', credentials.password);
      return true;
    })()`);
    if (submitted) {
      await this.run(["click", "button[type=submit]"]);
      await this.run(["wait", "--fn", "location.pathname.startsWith('/ctrl/agent')"]);
    }
  }
}
