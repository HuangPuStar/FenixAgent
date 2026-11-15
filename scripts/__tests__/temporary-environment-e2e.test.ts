import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { fixture } from "./fixtures/temporary-environment-e2e";

const script = resolve(import.meta.dir, "../temporary-environments/e2e.ts");

// 缺少到期校验、身份复用或文件隔离断言时，脚本不能把完整链路误报为通过。
test("temporary environment CLI runs concurrent two-turn ACP/OpenAI conversations and restores policy", async () => {
  const f = fixture();
  try {
    const result = await f.result;
    expect(result.output).not.toContain(f.apiKey);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("[PASS]");
    expect(result.output).toContain("HTTP 410");
    expect(f.conversation()).toEqual({ turns: { acp: 2, openai: 2 }, peakRequests: 2, sessionsCreated: 1 });
    expect(f.policy().source).toBe("default");
    expect([...f.instances.values()].map((item) => item.status)).toEqual(["stopped", "stopped"]);
  } finally {
    f.stop();
  }
}, 15_000);

// 第二轮上下文串线、错误 ACP session、RPC 错误和中途断线都必须使真实 CLI 失败并恢复策略。
test.each([
  "openai-memory",
  "acp-session",
  "acp-error",
  "acp-close",
] as const)("conversation fault %s is detected and cleaned up", async (fault) => {
  const f = fixture(fault);
  try {
    const result = await f.result;
    expect(result.exit).toBe(1);
    expect(result.output).not.toContain(f.apiKey);
    expect(f.policy().source).toBe("default");
    expect([...f.instances.values()].map((item) => item.status)).toEqual(["stopped", "stopped"]);
  } finally {
    f.stop();
  }
}, 15_000);

// 续聊句柄改变时必须判失败，诊断输出不能泄漏新旧不透明句柄。
test("a changed continuation handle fails without exposing either handle", async () => {
  const f = fixture("openai-handle");
  try {
    const result = await f.result;
    expect(result.exit).toBe(1);
    for (const handle of f.handles) expect(result.output).not.toContain(handle);
    expect(f.policy().source).toBe("default");
  } finally {
    f.stop();
  }
}, 15_000);

// 请求失败仍需恢复原 TTL，既能恢复默认，也能恢复原有自定义覆盖；凭据不能随错误输出泄漏。
test.each([null, 90])("a failed chat restores TTL=%s and stops both test instances", async (original) => {
  const f = fixture("chat", original);
  try {
    const result = await f.result;
    expect(result.exit).toBe(1);
    expect(result.output).not.toContain(f.apiKey);
    expect(f.policy().ttlSeconds).toBe(original);
    expect([...f.instances.values()].map((item) => item.status)).toEqual(["stopped", "stopped"]);
  } finally {
    f.stop();
  }
});

// 后端错误接受过期 connect 时，测试必须非零退出，不能只打印响应而漏掉契约断言。
test("an expired connect that succeeds is reported as a failure", async () => {
  const f = fixture("expiry");
  try {
    const result = await f.result;
    expect(result.exit).toBe(1);
    expect(result.output).toContain("410");
    expect(f.policy().source).toBe("default");
  } finally {
    f.stop();
  }
}, 15_000);

// 脚本必须能识别环境文件泄漏，而不是只验证上传和下载都返回成功。
test("a workspace isolation breach causes a nonzero exit", async () => {
  const f = fixture("leak");
  try {
    const result = await f.result;
    expect(result.exit).toBe(1);
    expect(result.output).toContain("B 不得看到 A 上传的文件");
    expect(f.policy().source).toBe("default");
  } finally {
    f.stop();
  }
});

// 后续 PUT 未生效时仍由脚本持有上次成功写入的短 TTL，不能误判外部修改而遗留该策略。
test("a failed subsequent TTL write still restores the preceding script-owned policy", async () => {
  const f = fixture("ttl");
  try {
    const result = await f.result;
    expect(result.exit).toBe(1);
    expect(f.policy().source).toBe("default");
    expect([...f.instances.values()].map((item) => item.status)).toEqual(["stopped", "stopped"]);
  } finally {
    f.stop();
  }
}, 15_000);

// 202 只表示受理，后台状态变为 unknown 时脚本必须判失败并恢复策略。
test("an accepted stop that becomes unknown cannot be reported as completed", async () => {
  const f = fixture("stop-failure");
  try {
    const result = await f.result;
    expect(result.exit).toBe(1);
    expect(result.output).toContain("后台停止未确认");
    expect(f.policy().source).toBe("default");
  } finally {
    f.stop();
  }
}, 15_000);

// 配置错误应指出缺少的输入，不能只输出笼统失败或泄漏配置值。
test("missing credentials produce an actionable configuration error", async () => {
  const child = Bun.spawn([process.execPath, "run", script], {
    env: { ...process.env, FENIX_USER_API_KEY: "", FENIX_AGENT_ID: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit).toBe(1);
  expect(out + err).toContain("FENIX_USER_API_KEY");
});

// 恢复策略失败必须保留失败结论，同时继续清理实例，不能被 finally 中的异常截断清理。
test("cleanup failures remain visible while remaining instances are stopped", async () => {
  const f = fixture("restore");
  try {
    const result = await f.result;
    expect(result.exit).toBe(1);
    expect(result.output).toContain("清理失败");
    expect([...f.instances.values()].map((item) => item.status)).toEqual(["stopped", "stopped"]);
  } finally {
    f.stop();
  }
});

// Ctrl+C 中断等待中的真实 fetch 后，清理请求仍需用独立取消域完成。
test("SIGINT aborts the running request but still restores TTL and stops instances", async () => {
  const f = fixture("interrupt");
  try {
    await Promise.race([
      f.chatting,
      f.child.exited.then(() => {
        throw new Error("CLI exited before reaching chat");
      }),
    ]);
    f.child.kill("SIGINT");
    const result = await f.result;
    expect(result.exit).toBe(130);
    expect(f.policy().source).toBe("default");
    expect([...f.instances.values()].map((item) => item.status)).toEqual(["stopped", "stopped"]);
  } finally {
    f.stop();
  }
}, 15_000);

// 清理阶段收到 Ctrl+C 也应保留用户取消的退出码，同时完成独立取消域中的清理。
test("SIGINT during cleanup still exits with 130 after restoring policy", async () => {
  const f = fixture("cleanup-interrupt");
  try {
    await Promise.race([
      f.cleaning,
      f.child.exited.then(() => {
        throw new Error("CLI exited before cleanup");
      }),
    ]);
    f.child.kill("SIGINT");
    // 信号由子进程事件循环接收后再放行 HTTP，避免仅测试信号投递的调度先后。
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.finishCleaning();
    const result = await f.result;
    expect(result.exit).toBe(130);
    expect(f.policy().source).toBe("default");
    expect([...f.instances.values()].map((item) => item.status)).toEqual(["stopped", "stopped"]);
  } finally {
    f.stop();
  }
}, 15_000);
