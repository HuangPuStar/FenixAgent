// packages/resources/sandbox/src/__tests__/sandbox-source-migration.test.ts
// Sandbox 的**包边界契约测试**（任务 1.3 §1 静态条件）。
//
// 为什么重写为引用面断言：本包是资源包模板，它必须能在没有宿主解析环境（`apps/server` / `apps/web`
// 的 tsconfig 与 vite 别名）的情况下独立构建。「文件已在某个路径」证明不了这件事，源码字符串包含
// 更不行——`src/server.ts` 的导出面仍在收敛（T2c 正在精简 `./server` 出口），钉死文本会让测试在
// 每次合法收敛后误报；反过来，引用面只要出现一条宿主导入，包就已经失去独立构建能力。
//
// 原实现另有一处**恒真**：旧路径按仓库根解析，而仓库根下没有 `src/`，于是「旧路径已删除」永远成立。
// 这里改为按宿主根（`apps/server` / `apps/web`）解析，断言才有约束力。
//
// 扫描口径：先剥注释（注释里会举例写出宿主别名，直接匹配会误报），再取 import/export 说明符；
// `import type` 也算——类型导入同样把宿主路径写进包内，宿主解析环境一变就断。
// 本测试只读文件、不 import 被测模块，因此不会把被测代码的副作用（懒加载宿主单例等）带进来。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/sandbox`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 仓库根；旧路径与新 owner 路径都以它为基准记录。 */
const REPO_ROOT = resolve(PKG_ROOT, "../../..");
/** 包内源码入口；README 等文档里的示例不属于可解析引用，不参与扫描。 */
const SOURCE_ENTRIES = ["src", "web", "fenix.module.ts"];

/**
 * 唯一允许的宿主导入。
 *
 * 表定义迁出归任务 1.7，本任务把它作为**显式残留**保留（见任务 1.3 实施记录 §四），
 * 且只允许这一条精确路径：`@server/db/schema` 之下的任何深路径都意味着重新伸手取宿主内部。
 */
const ALLOWED_HOST_IMPORT = "@server/db/schema";

/**
 * RMD-03 迁移映射（宿主旧路径 → 包内新 owner 路径）。
 *
 * 记成「一对」而不是两份清单：旧路径残留（第二份实现复活）与新路径缺失是同一次迁移失败的两种
 * 表现，成对记录才能让失败信息同时指出两端。
 *
 * 注意 `apps/web/src/routes/admin/sandbox.tsx` 与 `apps/web/src/__tests__/system-sandbox.test.ts`
 * 保留在宿主是既定分工（WebShell 薄 route adapter，归 §1.6），不在本清单里，不要当成残留删除。
 */
const MIGRATION_PAIRS: ReadonlyArray<readonly [hostPath: string, packagePath: string]> = [
  ["apps/server/src/routes/api/sandbox.ts", "src/routes/api/sandbox.ts"],
  ["apps/server/src/routes/api/sandbox-cluster.ts", "src/routes/api/sandbox-cluster.ts"],
  ["apps/server/src/routes/api/sandbox-server.ts", "src/routes/api/sandbox-server.ts"],
  ["apps/server/src/__tests__/api-sandbox-schema.test.ts", "src/__tests__/api-sandbox-schema.test.ts"],
  ["apps/server/src/__tests__/api-sandbox-server.test.ts", "src/__tests__/api-sandbox-server.test.ts"],
  ["apps/server/src/__tests__/sandbox-api-error-mapping.test.ts", "src/__tests__/sandbox-api-error-mapping.test.ts"],
  [
    "apps/server/src/__tests__/sandbox-cluster-admin-service.test.ts",
    "src/__tests__/sandbox-cluster-admin-service.test.ts",
  ],
  ["apps/server/src/__tests__/sandbox-config.test.ts", "src/__tests__/sandbox-config.test.ts"],
  ["apps/server/src/__tests__/sandbox-default-pool.test.ts", "src/__tests__/sandbox-default-pool.test.ts"],
  ["apps/server/src/__tests__/sandbox-execution-handler.test.ts", "src/__tests__/sandbox-execution-handler.test.ts"],
  ["apps/server/src/__tests__/sandbox-manager.test.ts", "src/__tests__/sandbox-manager.test.ts"],
  ["apps/server/src/__tests__/sandbox-pool-config-api.test.ts", "src/__tests__/sandbox-pool-config-api.test.ts"],
  ["apps/server/src/__tests__/sandbox-provider-registry.test.ts", "src/__tests__/sandbox-provider-registry.test.ts"],
  ["apps/server/src/__tests__/sandbox-schema.test.ts", "src/__tests__/sandbox-schema.test.ts"],
  [
    "apps/server/src/__tests__/sandbox-server-admin-service.test.ts",
    "src/__tests__/sandbox-server-admin-service.test.ts",
  ],
  ["apps/web/src/api/sandbox-pools.ts", "web/src/api/sandbox-pools.ts"],
  ["apps/web/src/api/system-sandbox.ts", "web/src/api/system-sandbox.ts"],
  ["apps/web/src/pages/admin/AdminSandboxPage.tsx", "web/src/pages/admin/AdminSandboxPage.tsx"],
  ["apps/web/src/pages/admin/utils.ts", "web/src/pages/admin/utils.ts"],
  ["apps/web/src/pages/admin/components/MasterKeyGate.tsx", "web/src/pages/admin/components/MasterKeyGate.tsx"],
  [
    "apps/web/src/pages/admin/components/RemoteSandboxPanel.tsx",
    "web/src/pages/admin/components/RemoteSandboxPanel.tsx",
  ],
  [
    "apps/web/src/pages/admin/components/SearchableUsageFilter.tsx",
    "web/src/pages/admin/components/SearchableUsageFilter.tsx",
  ],
];

/** 去掉行注释与块注释；字符串字面量内的内容原样保留（说明符本身就在引号里）。 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: '"' | "'" | "`" | null = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * 说明符抓取模式：`from` 形式（含多行命名导入）、副作用导入、动态 `import()`。
 *
 * `from` 形式锚在行首并止步于 `;`，避免把函数体或正则字面量里的 `from "…"` 文本当成语句。
 */
const SPECIFIER_PATTERNS = [
  /^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*["']([^"']+)["']/gm,
  /^[ \t]*import[ \t]*["']([^"']+)["']/gm,
  /\bimport[ \t]*\([ \t]*["']([^"']+)["']/g,
];

/** 说明符的首字符形态：正则字面量里的 `from "…"` 会被上述模式捞出，不属于模块说明符的一律丢弃。 */
const SPECIFIER_LEAD = /^[A-Za-z0-9@._/-]/;

function extractSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      if (SPECIFIER_LEAD.test(match[1])) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** 递归收集 `.ts` / `.tsx`；跳过 `node_modules`（包内软链指向别的包的实现，不是本包源码）。 */
function listPackageFiles(absDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules") continue;
    const child = join(absDir, entry.name);
    if (entry.isDirectory()) files.push(...listPackageFiles(child));
    else if (/\.tsx?$/.test(entry.name)) files.push(child);
  }
  return files;
}

interface ImportRef {
  file: string;
  specifier: string;
}

const sourceFiles = SOURCE_ENTRIES.flatMap((entry) => {
  const abs = resolve(PKG_ROOT, entry);
  if (!existsSync(abs)) return [];
  return statSync(abs).isDirectory() ? listPackageFiles(abs) : [abs];
});

const refs: ImportRef[] = sourceFiles.flatMap((file) =>
  extractSpecifiers(stripComments(readFileSync(file, "utf8"))).map((specifier) => ({ file, specifier })),
);

const describeRef = (ref: ImportRef) => `${relative(PKG_ROOT, ref.file)} → ${ref.specifier}`;

/** 某个入口（目录或单文件）下的已扫描文件。 */
function filesUnder(entry: string): string[] {
  const abs = resolve(PKG_ROOT, entry);
  return sourceFiles.filter((file) => file === abs || file.startsWith(`${abs}/`));
}

/** web 贡献的已扫描文件；宿主别名只可能在 web 面出现，作用域断言按这个集合收敛。 */
const webFiles = new Set(filesUnder("web"));

/** 相对说明符是否落在包外：`resolve` 折叠 `..` 段，宿主与兄弟资源包都会在这里现形。 */
function escapesPackage(file: string, specifier: string): boolean {
  return !resolve(dirname(file), specifier).startsWith(`${PKG_ROOT}/`);
}

const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
  exports?: Record<string, string>;
};
const exportEntries = Object.entries(manifest.exports ?? {});

describe("Sandbox 包边界契约（任务 1.3 §1 静态条件）", () => {
  // 遍历有效性自检：walker 若只返回入口文件，后续「不存在违规引用」的断言会全部退化为恒真。
  test("扫描有效性自检：源码集合覆盖全包，且已知残留宿主导入能被扫到", () => {
    for (const expected of [
      "fenix.module.ts",
      "src/server.ts",
      "src/routes/api/sandbox.ts",
      "src/routes/api/sandbox-cluster.ts",
      "src/routes/api/sandbox-server.ts",
      "src/routes/web/sandbox-pools.ts",
      "src/__tests__/guard-stubs.ts",
      "web/index.ts",
      "web/src/api/system-sandbox.ts",
      "web/src/pages/admin/AdminSandboxPage.tsx",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(60);
    // 正向控制：表定义残留必然存在，扫不到就说明说明符提取失效（而不是「没有宿主导入」）。
    expect(refs.filter((ref) => ref.specifier === ALLOWED_HOST_IMPORT).length).toBeGreaterThan(0);
  });

  // RMD-03 完成后宿主侧不得保留 Sandbox 的第二份实现，否则新旧两套会各自漂移。
  test("Sandbox 宿主旧路径已全部删除", () => {
    const survivors = MIGRATION_PAIRS.map(([hostPath]) => hostPath).filter((hostPath) =>
      existsSync(resolve(REPO_ROOT, hostPath)),
    );
    expect(survivors).toEqual([]);
  });

  // 迁移必须落到包内约定目录：宿主旧文件删了但新实现没落地，等于能力直接消失。
  test("Sandbox 文件均落在包内新 owner 路径", () => {
    const missing = MIGRATION_PAIRS.map(([, packagePath]) => packagePath).filter(
      (packagePath) => !existsSync(resolve(PKG_ROOT, packagePath)),
    );
    expect(missing).toEqual([]);
  });

  // 宿主实现只能经平台契约（`@fenix/platform-sdk`）或注入进入本包；除表定义残留外一律违规。
  test("包内不存在表定义以外的宿主 @server 导入", () => {
    const offenders = refs.filter(
      (ref) => ref.specifier.startsWith("@server/") && ref.specifier !== ALLOWED_HOST_IMPORT,
    );
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 宿主别名（`@/src`、`@/components`）由 apps/web 的 tsconfig/vite 提供，包离开宿主就解析不了。
  test("包内 web 不引用宿主别名 @/", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@/") && webFiles.has(ref.file));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 相对路径是最隐蔽的越界方式：`../../../apps/web/...` 在宿主内能跑通，包单独构建时目录不存在。
  test("包内不存在穿透到包外的相对路径引用", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith(".") && escapesPackage(ref.file, ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 环境变量读取与校验统一在宿主（§1.5）：包内直读 `process.env` 会把部署知识复制进资源模块，
  // 两处默认值会分歧。标题刻意不写该字面量——本文件也在扫描范围内，标题会被自己扫成违规。
  test("包内 src 不直读宿主环境变量", () => {
    const offenders = filesUnder("src").flatMap((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return code
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /\bprocess\.env\b/.test(line))
        .map(({ number }) => `${relative(PKG_ROOT, file)}:${number}`);
    });
    expect(offenders).toEqual([]);
  });

  // exports 是本包对宿主的唯一解析入口，目标写错只在宿主构建/装配时才暴露，这里提前钉住。
  test("package.json 的每条 exports 目标都真实存在", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
    const missing = exportEntries.filter(([, target]) => !existsSync(resolve(PKG_ROOT, target)));
    expect(missing.map(([key, target]) => `${key} → ${target}`)).toEqual([]);
  });

  // `./module` 与 `./web` 是模块注册与浏览器装配的锚点：指错文件会让宿主取到错误的贡献形状。
  test("package.json 的 ./module 与 ./web 指向约定文件", () => {
    expect(manifest.exports?.["./module"]).toBe("./fenix.module.ts");
    expect(manifest.exports?.["./web"]).toBe("./web/index.ts");
  });

  // 跨包只能走对方根入口的公开导出；深入 `@fenix/*/src` 会把别的包的内部实现拖进本包依赖面。
  test("跨包引用不深入其他包的 src 内部路径", () => {
    const offenders = refs.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });
});
