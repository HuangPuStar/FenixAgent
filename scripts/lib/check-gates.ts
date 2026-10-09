/**
 * 门禁步骤目录：`precheck`（预发布全量）与 `fastcheck`（单任务收尾快检）共用的**同一份**步骤定义。
 *
 * **为什么单独成模块**：两个入口对「哪些门禁存在、各自的命令与判定标记是什么」必须完全一致——一旦
 * 分叉，快检就会对同一改动给出与预发布不同的结论（例如某条门禁只在 precheck 里接线）。它也不能放进
 * 任一入口文件：入口的模块顶层会执行门禁，`import` 它会连带触发整轮运行。
 *
 * **唯一允许的差异是类型检查器**（见 `staticGates(checker)`）：precheck 用官方 `tsc`——发布门禁要的是
 * 稳定、与编辑器同版本；fastcheck 用 `tsc-rs`——同一批 tsconfig、同一批目标，本仓实测诊断逐字一致
 * （38 包报错位置集合相同），而冷启动耗时 4.8s / 7.8s / 19.9s → 0.7s / 0.8s / 3.0s，迭代时手感差别很大。
 *
 * **tsc-rs 的临时性**（`tsc-rs@0.1.0`）：它是 TypeScript 7 编译器（Go）的 Rust 移植，实验性质、只发布
 * linux-x64 与 macOS-arm64 两种平台二进制，bun 还会拦截它的 postinstall——所以「装了」不等于「能用」，
 * 只能试运行探活，失败即回退 `tsc`（`hasFastTypeChecker`）。移除条件：官方 `typescript@7` 的编译器 API
 * 稳定（本仓 7 处门禁脚本依赖 `ts.createSourceFile` 等 AST API，7.0.2 已不再从根导出）后改用官方原生
 * 编译器，并删掉 `tsc-rs` 依赖。
 *
 * 步骤的执行语义（并发、超时、输出上限、失败诊断）见 `scripts/lib/check-runner.ts`。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { filterTestSummary } from "../ci-output";
import { filterTsc, filterVerified, REPOSITORY_ROOT, type Step, tscIncrementalArgs } from "./check-runner";

/** 类型检查器：官方 `tsc` 与快检用的 `tsc-rs`。 */
export type TypeChecker = "tsc" | "tsc-rs";

const FAST_TYPE_CHECKER = "tsc-rs";

/**
 * `node_modules/.bin/tsc-rs`：由 bun install 从包的 `bin` 字段生成，因此「文件在」只说明装了包，
 * 不说明平台二进制可用（tsc-rs 只发布 linux-x64 / macOS-arm64，且其 postinstall 会被 bun 拦截）。
 */
const FAST_TYPE_CHECKER_BIN = join(REPOSITORY_ROOT, "node_modules", ".bin", FAST_TYPE_CHECKER);

/** 探活快检检查器：真正跑一次 `--version`，能退出 0 才认为可用；失败（缺包 / 平台无二进制）即回退。 */
export async function hasFastTypeChecker(): Promise<boolean> {
  if (!existsSync(FAST_TYPE_CHECKER_BIN)) return false;
  try {
    const proc = Bun.spawn([FAST_TYPE_CHECKER_BIN, "--version"], {
      cwd: REPOSITORY_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * 静态门禁：生成物一致性、架构、依赖边界、类型检查。不含写盘修复（即 `BIOME_STEP`）与测试批次。
 *
 * 声明顺序即 `--list` 与文档的阅读顺序（按职责分组）；实际启动顺序按 `weight` 降序，见 `runWave`。
 */
export function staticGates(checker: TypeChecker): readonly Step[] {
  return [
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
      // docs/developer/guide/forbidden-code-patterns.md。
      name: "web-style",
      cmd: "bun run check:web-style",
      filter: filterVerified("✓ web-style"),
      weight: 630,
    },
    ...typecheckGates(checker),
    {
      name: "dependency-boundaries",
      cmd: "bun run check:dependencies",
      filter: filterVerified("✓ dependency-boundaries"),
      weight: 8300,
    },
  ];
}

/**
 * 类型检查三步。两种检查器的目标、判定与失败口径完全一致，只有二进制与缓存策略不同：
 * `tsc` 走 `--incremental`（缓存落在 `TSC_BUILD_INFO_DIR`，warm 后三步合计约 20s）；`tsc-rs` 冷启动
 * 就比它快一个量级，且两套工具链的 tsbuildinfo 格式不同、不能共用同名缓存文件，故显式关掉增量——
 * 顺带保证快检不往仓库写任何缓存。
 */
function typecheckGates(checker: TypeChecker): readonly Step[] {
  if (checker === FAST_TYPE_CHECKER) {
    return [
      {
        name: "tsc-rs (server)",
        cmd: `${FAST_TYPE_CHECKER} --noEmit --incremental false`,
        filter: filterTsc,
        weight: 900,
      },
      {
        name: "tsc-rs (web)",
        cmd: `${FAST_TYPE_CHECKER} -p apps/web/tsconfig.json --noEmit --incremental false`,
        filter: filterTsc,
        weight: 1_200,
      },
      {
        // 包级 tsconfig 逐个检查：根 `tsc` 与 web `tsc` 都**顺 import** 走，没有消费方的包/文件天然
        // 落在检查之外。口径、并发与测试文件豁免的移除条件见 `scripts/typecheck-packages.ts` 头部。
        name: "tsc-rs (packages)",
        cmd: `bun run scripts/typecheck-packages.ts --bin ${FAST_TYPE_CHECKER}`,
        filter: filterVerified("✓ typecheck-packages"),
        weight: 4_000,
      },
    ];
  }

  return [
    {
      name: "tsc (server)",
      cmd: `tsc --noEmit ${tscIncrementalArgs("tsc-server")}`,
      filter: filterTsc,
      weight: 8500,
    },
    {
      name: "tsc (web)",
      cmd: `tsc -p apps/web/tsconfig.json --noEmit ${tscIncrementalArgs("tsc-web")}`,
      filter: filterTsc,
      weight: 18_000,
    },
    {
      // 包级 tsconfig 逐个检查：根 `tsc` 与 web `tsc` 都**顺 import** 走，没有消费方的包/文件天然
      // 落在检查之外。口径、并发与测试文件豁免的移除条件见 `scripts/typecheck-packages.ts` 头部。
      name: "tsc (packages)",
      cmd: "bun run typecheck:packages",
      filter: filterVerified("✓ typecheck-packages"),
      weight: 24_000,
    },
  ];
}

/** 预发布门禁的静态步骤（官方 `tsc`）。 */
export const STATIC_GATES: readonly Step[] = staticGates("tsc");

/** 快检的静态步骤（`tsc-rs`，探活失败时调用方回退到 `STATIC_GATES`）。 */
export const FAST_STATIC_GATES: readonly Step[] = staticGates(FAST_TYPE_CHECKER);

/**
 * 全量测试批次（预发布语义）。三批的划分口径是**测试根目录的归属**而非耗时：改动其中一个根目录即可
 * 单独重跑该批；快检按变更影响范围只取其中若干批，见 `scripts/lib/affected-tests.ts`。
 */
export const TEST_BATCHES: readonly Step[] = [
  {
    name: "server-and-script-tests",
    cmd: "bun test apps/server/src/__tests__/ scripts/__tests__/ packages/platform/platform-sdk/src/__tests__/ 2>&1",
    filter: filterTestSummary,
    weight: 20_000,
  },
  {
    name: "package-tests",
    cmd: "bun test packages/ --path-ignore-patterns 'tmp/**' 2>&1",
    filter: filterTestSummary,
    weight: 20_000,
  },
  {
    name: "web-app-tests",
    cmd: "bun test apps/web/src/__tests__/ 2>&1",
    filter: filterTestSummary,
    weight: 20_000,
  },
];
