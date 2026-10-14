/**
 * 门禁步骤目录：`precheck`（预发布全量）与 `fastcheck`（单任务收尾快检）共用的**同一份**步骤定义。
 *
 * **为什么单独成模块**：两个入口对「哪些门禁存在、各自的命令与判定标记是什么」必须完全一致——一旦
 * 分叉，快检就会对同一改动给出与预发布不同的结论（例如某条门禁只在 precheck 里接线）。它也不能放进
 * 任一入口文件：入口的模块顶层会执行门禁，`import` 它会连带触发整轮运行。
 *
 * **类型检查器只有一个：`tsc-rs`**（`tsc-rs@0.6.0`，TypeScript 7 编译器的 Rust 移植）。2026-10 全量切换，
 * 实测依据：本仓 server / web / 包级三种程序上，它与官方 `tsc`（`typescript@6.0.3`）的诊断逐条一致
 * （含被豁免的测试文件计数 `ignored-tests=292`），而 CPU 时间远低于后者（包级 316s → 43s），
 * 含 4 处错误的样例上两边输出逐字相同。官方 `tsc` 自此只作为 `typescript` 包的副产物存在——供 6 个门禁
 * 脚本与 1 个测试文件解析 AST（`ts.createSourceFile`，见 check-architecture / web-style /
 * import-references / module-manifest-source / generate-module-registry），不再有任何门禁调用 `tsc`。
 *
 * **代价（写在这里，免得以后当成 bug 排查）**：`tsc-rs@0.6.0` 只发布 linux / macOS / Windows × x64 / arm64
 * 六个平台的二进制包，之外没有原生二进制；bun 还会拦截它的 postinstall，bin 停在 JS launcher——这不
 * 妨碍可用（launcher 自己解析平台包再 exec 原生二进制，每次调用多一次约 50ms 的 Node 启动），但
 * 「装了」不等于「能跑」，所以入口先探活（`typeCheckerIssue`），探活失败即失败退出而不是静默回退到
 * 别的编译器（口径随机器变比不可用更危险）；CI 跑 linux-x64，不受影响。
 * 升级/移除条件：`typescript@7` 的根导出不再提供 `ts.createSourceFile` 等 AST API（本仓 7 处仍在用），
 * 官方编译器因此暂时覆盖不了 AST 面；等它能同时覆盖类型检查与 AST 时，改用它并删掉 `tsc-rs` 与 `typescript`。
 *
 * 步骤的执行语义（并发、超时、输出上限、失败诊断）见 `scripts/lib/check-runner.ts`。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { filterTestSummary } from "../ci-output";
import { filterTsc, filterVerified, REPOSITORY_ROOT, type Step } from "./check-runner";

/** 类型检查器二进制名（`node_modules/.bin/` 下），同时也是 `scripts/typecheck-packages.ts` 用的那一个。 */
export const TYPE_CHECKER = "tsc-rs";

/**
 * 探活类型检查器：可用返回 null，否则返回给用户看的失败原因。只跑一次 `--version`——`node_modules/.bin/tsc-rs`
 * 由 bun install 从包的 `bin` 字段生成，「文件在」只说明装了包，不说明平台二进制可用（只发布六个平台的
 * 二进制包，其余平台装得上也跑不起来）。
 */
export async function typeCheckerIssue(): Promise<string | null> {
  const bin = join(REPOSITORY_ROOT, "node_modules", ".bin", TYPE_CHECKER);
  if (!existsSync(bin)) {
    return `找不到类型检查器 ${bin}（先运行 bun install）。`;
  }
  try {
    const proc = Bun.spawn([bin, "--version"], { cwd: REPOSITORY_ROOT, stdout: "ignore", stderr: "ignore" });
    if ((await proc.exited) === 0) return null;
    return `${TYPE_CHECKER} 无法运行：它只发布 linux / macOS / Windows × x64 / arm64 六个平台的二进制，当前平台 ${process.platform}-${process.arch} 不在其中。`;
  } catch (error) {
    return `${TYPE_CHECKER} 启动失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * 两个入口共用的前置检查：探活失败即打印原因并以 1 退出。放在跑任何步骤之前——否则三步类型检查会各自失败，
 * 真实原因（当前平台没有对应二进制）会被淹没在步骤诊断里。**不回退官方 `tsc`**：口径随机器变比不可用更危险。
 */
export async function exitIfTypeCheckerUnavailable(): Promise<void> {
  const issue = await typeCheckerIssue();
  if (issue === null) return;
  console.error(`${issue}\n类型检查是门禁的一部分，探活失败即失败退出（不回退官方 tsc）。`);
  process.exit(1);
}

/**
 * 静态门禁：生成物一致性、架构、依赖边界、类型检查。不含写盘修复（即 `BIOME_STEP`）与测试批次。
 *
 * 声明顺序即 `--list` 与文档的阅读顺序（按职责分组）；实际启动顺序按 `weight` 降序，见 `runWave`。
 */
export const STATIC_GATES: readonly Step[] = [
  {
    name: "module-registry",
    cmd: "bun run generate:module-registry --check",
    filter: filterVerified("已验证"),
    weight: 460,
  },
  {
    name: "web-contributions",
    cmd: "bun run generate:web-contributions --check",
    filter: filterVerified("已验证"),
    weight: 250,
  },
  {
    // 根源码归属清单同样是「文档 == 规则表产出」的生成物门禁，必须与 CI 走同一入口。
    name: "owner-inventory",
    cmd: "bun run check:root-owner-inventory",
    filter: filterVerified("unowned=0 ambiguous=0"),
    weight: 525,
  },
  {
    // 表搬迁只搬位置、不改结构：schema 聚合结果与已发布迁移链必须零 DDL 差异（§6.1 / §10.6.1）。
    name: "schema-ddl-drift",
    cmd: "bun run check:schema-ddl-drift",
    filter: filterVerified("✓ schema-ddl-drift"),
    weight: 190,
  },
  {
    // 部署模板是生成物：各份 `.example` 与声明面（宿主 env.ts + 模块 envDefinitions）零差异，
    // 否则「部署能不能配全某个旋钮」只能靠人肉比对（§5.4）。
    name: "env-example",
    cmd: "bun run scripts/generate-env-example.ts --check",
    filter: filterVerified("✓ env-example"),
    weight: 60,
  },
  {
    name: "architecture",
    cmd: "bun run architecture:check",
    filter: filterVerified("✓ architecture-check"),
    weight: 1330,
  },
  {
    // Web 样式禁止行为（FCP-WEB-01..06）：台账登记存量，只阻断新增；规则与反例见
    // docs/developer/system/forbidden-code-patterns.md。
    name: "web-style",
    cmd: "bun run check:web-style",
    filter: filterVerified("✓ web-style"),
    weight: 630,
  },
  ...typecheckGates(),
  {
    name: "dependency-boundaries",
    cmd: "bun run check:dependencies",
    filter: filterVerified("✓ dependency-boundaries"),
    weight: 8300,
  },
];

/**
 * 类型检查三步。目标是三份 tsconfig（根 / web / 逐包），检查器只有 `tsc-rs` 一个（取舍见本文件头部）。
 * 三步都显式 `--incremental false`：`tsc` 时代的 tsbuildinfo 与它格式不同、不能沿用，而它冷跑本就很快
 * （40 包 8 路并发的 CPU 时间约 43s），显式关掉顺带保证门禁不往仓库写任何缓存文件。
 */
function typecheckGates(): readonly Step[] {
  return [
    {
      name: "tsc-rs (server)",
      cmd: `${TYPE_CHECKER} --noEmit --incremental false`,
      filter: filterTsc,
      weight: 900,
    },
    {
      name: "tsc-rs (web)",
      cmd: `${TYPE_CHECKER} -p apps/web/tsconfig.json --noEmit --incremental false`,
      filter: filterTsc,
      weight: 1_200,
    },
    {
      // 包级 tsconfig 逐个检查：根与 web 两份程序都**顺 import** 走，没有消费方的包/文件天然
      // 落在检查之外。口径、并发与测试文件豁免的移除条件见 `scripts/typecheck-packages.ts` 头部。
      name: "tsc-rs (packages)",
      cmd: "bun run typecheck:packages",
      filter: filterVerified("✓ typecheck-packages"),
      weight: 4_000,
    },
  ];
}

/**
 * 全量测试批次（预发布语义）。三批的划分口径是**测试根目录的归属**而非耗时：改动其中一个根目录即可
 * 单独重跑该批；快检按变更影响范围只取其中若干批，见 `scripts/lib/affected-tests.ts`。
 *
 * 三批都带 `--isolate`，且以**全量口径**与 `.github/workflows/ci.yml` 的测试命令对齐（`--isolate` 也不例外，
 * 那里是把同一批文件按 bun 原生 `--shard=i/N` 切到多个 runner，并集恒等于全量，判定不变）；
 * 运行版本同样要跟上 `.github/actions/setup/action.yml` 的 bun pin（≥ 1.4.3，理由见该文件注释）。
 * bun 1.4 默认让**所有测试文件共享同一个全局与模块注册表**：某文件里 `mock.module()` 的注册、
 * `globalThis` 覆写、平台替身（`stubDb()` / 模块配置 / 应用基础设施）都会泄漏给**之后加载**的文件，而
 * 「谁先加载」由文件系统的目录枚举顺序决定——macOS 本机与 CI 的 Linux 顺序不同，于是同一份代码本机全绿、
 * CI 里 81 个用例失败（实测 2026-10-13：trace / workflow-v2 / memory 的 i18n 用例退化成回显 key 或
 * `i18n` 为 undefined，沙盒实例投影用例拿到别的文件残留的 DB 替身）。`--isolate` 让每个文件独占全局与
 * 模块注册表（preload 随之按文件重跑），把「测试结果取决于文件装载顺序」这个不确定性从门禁里去掉。
 * 代价是每个文件重新求值一次依赖图：packages 批实测 121s → 230s，别为了省这 100 秒把它摘掉。
 */
export const TEST_BATCHES: readonly Step[] = [
  {
    name: "server-and-script-tests",
    cmd: "bun test apps/server/src/__tests__/ scripts/__tests__/ packages/platform/platform-sdk/src/__tests__/ --isolate 2>&1",
    filter: filterTestSummary,
    weight: 20_000,
  },
  {
    name: "package-tests",
    cmd: "bun test packages/ --path-ignore-patterns 'tmp/**' --isolate 2>&1",
    filter: filterTestSummary,
    weight: 20_000,
  },
  {
    name: "web-app-tests",
    cmd: "bun test apps/web/src/__tests__/ --isolate 2>&1",
    filter: filterTestSummary,
    weight: 20_000,
  },
];
