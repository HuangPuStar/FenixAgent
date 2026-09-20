/**
 * 测试工作区根锁：`process.env.WORKSPACE_ROOT` 的进程级独占。
 *
 * **为什么需要**：Bun 在同一进程内**并发**执行测试文件（默认行为；`--max-concurrency` 只约束同一文件
 * 内的 test，`--isolate` 会让整仓包测试从数十秒涨到十分钟以上，不可用），而 workspace 根是进程级环境
 * 变量，由 `resolveWorkspacePath` 在每次调用时直读。多个测试文件各自 `mkdtemp` 后写入该变量，会让同一次
 * 操作序列里的「写入」与「读取/打包」解析到**不同**的根。
 *
 * **不要拿本锁解释 `downloadZip` 空流现象**（2026-09-20 更正）：该现象一度被归因为「workspace 根串台」，
 * 实测已否。真实成因是 bun 1.3.13 的运行时缺陷——进程内求值的模块图变大后，spawn 出的子进程写不进任何
 * fd：stdout 指向 pipe 或普通文件同样失效，`Bun.spawn` 与 `node:child_process` 的 spawn / spawnSync /
 * execSync 四种入口全部复现，`zip` 退出码 10（stdout EPIPE）、`echo` 退出码 1 且输出为空。它才是「单文件
 * 必过、全量必挂」的原因，与锁无关：bun 1.4.2 上同一复现组合 0 失败，`--isolate` 与
 * `--max-concurrency 1` 都无效（失败边界是进程内的模块图规模，不是并发或跨文件注册表污染）。
 *
 * **规则**：凡是用例把 workspace 根挂到 `WORKSPACE_ROOT` 上的测试文件（含按用例切换根的），都必须经本锁
 * 持有它——锁必须跨包共享，只在一个包内互斥等于没锁（别的包的文件照旧改根）。同步窗口内「设置并读回」的
 * 用例（如纯路径解析断言）不跨 await，不会被打断，可以不参与。
 *
 * **用法**：`beforeEach` 或用例体内 `await lockTestWorkspaceRoot(root)`；`afterEach` 里 **先**恢复/删除
 * `WORKSPACE_ROOT`（`unlockTestWorkspaceRoot(previous)` 可直接代为恢复），**再**解锁。顺序不可颠倒：先解锁
 * 会让下一个文件立刻写入它自己的根，本文件随后的删除/恢复就把对方的根改坏了。
 *
 * 传 `undefined` 表示「本用例要求根处于未设置状态」（缺省回退 `cwd/workspaces` 的用例需要它），锁的语义
 * 是「独占根状态」而不是「独占某个值」。
 *
 * 这不是替身：它不进 `resetAllStubs()`——锁的生命周期是「用例持有到用例结束」，挂进复位流程等于在每个
 * `beforeEach` 里放锁，互斥立刻失效。
 */

/** 等待上限：仅用于打破「持有者因异常路径未释放」造成的死锁。 */
const LOCK_WAIT_TIMEOUT_MS = 180_000;

let tail: Promise<void> = Promise.resolve();
let release: (() => void) | undefined;

/** 排队取得工作区根独占，并把 `WORKSPACE_ROOT` 设为给定根（`undefined` = 置为未设置）。 */
export async function lockTestWorkspaceRoot(root: string | undefined): Promise<void> {
  const wait = tail;
  let done!: () => void;
  tail = new Promise<void>((resolve) => {
    done = resolve;
  });
  // 超时后照常获取：宁可让互斥短暂失效（表现为可诊断的根争用失败），也不要让整个测试进程挂死。
  await Promise.race([wait, new Promise<void>((resolve) => setTimeout(resolve, LOCK_WAIT_TIMEOUT_MS))]);
  release = done;
  applyRoot(root);
}

/**
 * 释放工作区根独占（幂等）。
 *
 * **未持锁时是空操作**：一个从未取锁的用例（或同一文件里不参与锁的用例）在 `afterEach` 里调用它，
 * 若照旧写根，就等于替并发持有者改了根——那正是本锁要排除的争用，且这种写法会随「先删根再解锁」
 * 的既有习惯悄悄回归。因此「写根」只在真正持锁时发生。（持锁者用 `previous` 恢复原值仍是允许的：
 * `undefined` = 删除，这是「保留原值再还原」用例最省事的写法，也避免调用方漏掉恢复那一步。）
 */
export function unlockTestWorkspaceRoot(previous?: string): void {
  const done = release;
  if (!done) return;
  applyRoot(previous);
  release = undefined;
  done();
}

/** 写入根状态：`undefined` 表示删除（缺省回退到 `cwd/workspaces`）。 */
function applyRoot(root: string | undefined): void {
  if (root === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = root;
}
