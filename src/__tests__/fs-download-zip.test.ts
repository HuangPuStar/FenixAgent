// fs-download-zip.test.ts — downloadZip 子进程生命周期测试（F5）
//
// 与 agent-file-service.test.ts 拆分：该文件聚焦门面与本地/远程后端操作语义，
// 本文件只覆盖 downloadZip 的 spawn 子进程生命周期（error 映射、客户端断开
// kill、正常完成不误 kill）。独立文件避免单文件超过 500 行红线（CLAUDE.md）。
// 本文件复制了最小 gate setup（stub 环境归属 + 真实 tmp workspace 根），
// 与 agent-file-service.test.ts 的 beforeEach 语义保持一致；如 setup 演进，
// 两处需同步（暂不抽象——独立演进优先，避免过早共享测试基座）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setConfig } from "../config";
import { gate } from "../services/agent-file-service";
import type { FileAuthContext } from "../services/file-types";
import { resetAllStubs, stubEnvironmentRepo } from "../test-utils/helpers";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";

const authCtx: FileAuthContext = {
  organizationId: ORG_ID,
  userId: USER_ID,
  role: "owner",
  actorId: USER_ID,
  source: "user",
};

let workspaceRoot: string;

/** 收集 ReadableStream 全部数据（断言流式结果用） */
async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks);
}

/** 在 workspace 根下安装假 zip 可执行脚本并把 PATH 前置（返回恢复 PATH 的函数）。
 *  interpreter 选择执行解释器：
 *  - "sh"：`#!/bin/sh`（macOS 即 bash）。用于需要"存活时关闭 stdout 产生 EOF"
 *    的用例——bun 运行时持有 stdout pipe 写端副本，closeSync/end/destroy 均不
 *    产生 EOF，只有 bash 的 `exec 1>&-` 可以。
 *  - "bun"（默认）：`#!/usr/bin/env bun` 执行 JS。bash 为动态链接，冷启动
 *    （dyld 镜像加载）偶发 >2s（实测首轮 46% 概率卡住）会让依赖启动时序的
 *    轮询 flaky；bun 为静态链接二进制，启动 p99 ≈ 44ms。
 *  "{key}" 占位符按 placeholders 替换（pidFile/diedFlag 等）。
 *  仅用于 F5 子进程生命周期测试（真实系统 zip 无法观测子进程存活状态）。 */
async function installFakeZip(
  scriptBody: string,
  placeholders: Record<string, string>,
  interpreter: "sh" | "bun" = "bun",
): Promise<() => void> {
  const binDir = join(workspaceRoot, "fake-bin");
  await mkdir(binDir, { recursive: true });
  let script = scriptBody;
  for (const [key, value] of Object.entries(placeholders)) {
    script = script.replaceAll(`{${key}}`, value);
  }
  const shebang = interpreter === "sh" ? "#!/bin/sh\n" : "#!/usr/bin/env bun\n";
  await writeFile(join(binDir, "zip"), `${shebang}${script}`, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath}`;
  return () => {
    process.env.PATH = prevPath;
  };
}

/** 轮询读取假 zip 脚本写入的 PID 文件（spawn 事件先于脚本体执行返回，需等待落盘；
 *  上限 4s——极端负载下进程启动可能明显慢于均值） */
async function readZipPid(pidFile: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    try {
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      if (pid > 0) return pid;
    } catch {
      // pid 文件尚未写入，继续轮询
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`假 zip 脚本未在预期时间内写入 PID 文件: ${pidFile}`);
}

/** 轮询等待文件出现（每次间隔 20ms，上限 4s）；用于假 zip 脚本的阶段标记 */
async function waitForFile(filePath: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      await readFile(filePath, "utf8");
      return;
    } catch {
      // 文件尚未写入，继续轮询
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`文件未在预期时间内写入: ${filePath}`);
}

beforeEach(async () => {
  // 每个用例重建干净环境：stub 环境归属 + 独立 tmp workspace 根目录 + 本地路由
  resetAllStubs();
  stubEnvironmentRepo({
    getById: async () => ({ id: ENV_ID, organizationId: ORG_ID, userId: USER_ID }),
  });
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-download-zip-"));
  process.env.WORKSPACE_ROOT = workspaceRoot;
  setConfig({ defaultMachineId: undefined });
});

afterEach(async () => {
  delete process.env.WORKSPACE_ROOT;
  await rm(workspaceRoot, { recursive: true, force: true });
  setConfig({ defaultMachineId: undefined });
});

describe("downloadZip 子进程生命周期", () => {
  test("zip 不可执行（缺失）→ 503 file_service_unavailable，不挂死响应", async () => {
    // F5：spawn("zip") ENOENT 必须映射 503 统一错误（§2.4 契约），不得让流以
    // 未捕获错误中断已发出的响应（headers 发出后消费者只能看到连接中断）
    const fs = gate(ENV_ID, authCtx);
    await fs.mkdir("user/dir");
    const emptyBin = join(workspaceRoot, "empty-bin");
    await mkdir(emptyBin, { recursive: true });
    const prevPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      await expect(fs.downloadZip("user/dir")).rejects.toMatchObject({
        type: "file_service_unavailable",
        statusCode: 503,
      });
    } finally {
      process.env.PATH = prevPath;
    }
  });

  test("客户端断开（流被 destroy）→ kill zip 子进程，不残留悬空进程", async () => {
    // F5：响应流被 abort/destroy（客户端断开）时只触发 close 不触发 end，
    // 必须 kill 子进程——zip 打包是长任务，断开后不清理会一直占用资源。
    // 假 zip 脚本先注册 SIGTERM handler 再写 ready 标记：SIGTERM 送达 = kill 生效
    // （不轮询 process.kill(pid, 0)，避免 macOS PID 复用把"已退出"误报为
    // "存活"）；destroy 前等待 ready 标记，消除"信号早于 handler 注册"竞态。
    // 脚本用 `await new Promise(() => {})` 保持事件循环活跃：busy loop 若写成
    // 同步 while(true) 会饿死信号 handler（信号经事件循环递达，JS 忙循环不释放）
    const fs = gate(ENV_ID, authCtx);
    await fs.mkdir("user/dir");
    const pidFile = join(workspaceRoot, "fake-zip.pid");
    const diedFlag = join(workspaceRoot, "fake-zip-died");
    const readyFlag = join(workspaceRoot, "fake-zip-ready");
    const restorePath = await installFakeZip(
      `const fs = require("node:fs");\n` +
        `process.on("SIGTERM", () => { fs.writeFileSync("{diedFlag}", "killed"); process.exit(1); });\n` +
        `fs.writeFileSync("{pidFile}", String(process.pid));\n` +
        `fs.writeFileSync("{readyFlag}", "ready");\n` +
        `await new Promise(() => {});\n`,
      { pidFile, diedFlag, readyFlag },
    );
    let pid = 0;
    try {
      // BackEnd 契约返回 NodeJS.ReadableStream（无 destroy），运行时为 Readable——
      // 收窄后调用 destroy 模拟客户端断开（Response body 被 abort 的场景）
      const stream = (await fs.downloadZip("user/dir")) as Readable;
      await waitForFile(readyFlag);
      pid = await readZipPid(pidFile);
      stream.destroy();
      // SIGTERM → handler → 死亡标记落盘是异步的，轮询等待
      let killed = false;
      for (let i = 0; i < 200 && !killed; i++) {
        try {
          await readFile(diedFlag, "utf8");
          killed = true;
        } catch {
          // 死亡标记尚未写入，继续轮询
        }
        if (!killed) await new Promise((r) => setTimeout(r, 20));
      }
      expect(killed).toBe(true);
    } finally {
      restorePath();
      // 断言失败时兜底清理：事件循环空转进程若未被 kill 会持续占 CPU 并污染
      // 后续运行（历史教训），SIGKILL 确保测试失败也不残留；pid 未知时由
      // bun test 进程退出时的 dangling 进程清理兜底（bun 测试运行时行为）
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 进程已退出，无需清理
        }
      }
    }
  }, 15000);

  test("正常读完流 → 不误 kill 仍存活的 zip 子进程", async () => {
    // 打包完成先 end 再 close（autoDestroy）；此时子进程可能仍在收尾（zip 写完
    // stdout 尚未退出），不得误 kill——只有客户端断开（无 end 的 close）才终止
    // 子进程。脚本用 bash + exec 1>&- 使 EOF 先于进程退出到达（bun 脚本无法在
    // 存活时关闭 stdout pipe：bun 运行时持有写端副本，closeSync/end/destroy 均
    // 不产生 EOF，实测仅进程退出时才 EOF）；trap TERM 在 EOF 前注册，若产品误
    // kill（close 先于 end），SIGTERM 送达时进程仍存活（sleep 10），标记必然
    // 落盘。断言只依赖"kill 未送达"（sigtermFlag 不存在），不依赖 bash 启动
    // 速度——启动慢只推迟 EOF，不影响断言正确性（15s timeout 兜底）
    const fs = gate(ENV_ID, authCtx);
    await fs.mkdir("user/dir");
    const sigtermFlag = join(workspaceRoot, "fake-zip-sigterm");
    const restorePath = await installFakeZip(
      `trap 'echo killed > "{sigtermFlag}"' TERM\nprintf 'PK' >&1\nexec 1>&-\nsleep 10\n`,
      { sigtermFlag },
      "sh",
    );
    try {
      const stream = await fs.downloadZip("user/dir");
      const buffer = await collectStream(stream);
      expect(buffer.toString()).toBe("PK");
      // 留出 kill 生效窗口：若产品在 close 时误 kill，SIGTERM 应已送达并落盘
      await new Promise((r) => setTimeout(r, 500));
      let sigtermSeen = false;
      try {
        await readFile(sigtermFlag, "utf8");
        sigtermSeen = true;
      } catch {
        // 标记不存在 = 未被 kill（预期）
      }
      expect(sigtermSeen).toBe(false);
    } finally {
      restorePath();
      // 脚本 sleep 10 自然退出，无需清理（不占 CPU）；断言失败提前返回时残留
      // 进程由 bun test 进程退出时的 dangling 进程清理兜底
    }
  }, 15000);
});
