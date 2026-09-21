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
const SOURCE_ENTRIES = ["src", "web", "db", "fenix.module.ts"];

/**
 * 扫描器负例夹具（§4.7.1 ③ 的收缩形态）。
 *
 * 本包对宿主表定义的引用已随 §1.7 B4 归零（`sandbox_pool` / `sandbox_instance` 迁入本包 `db/`），
 * 原先那条「残留必然存在」的正向控制随之失效——它的作用是「扫不到就说明说明符提取失效」，而此刻
 * 扫不到才是正确结果。改用负例夹具承担同一职责：一段真实源码形状的字符串，含一条宿主导入与一条
 * **注释里**形似导入的文本，断言语义是「前者必须被捞出、后者必须被剥掉」。
 *
 * **注释为什么必须是块注释形状**（B4 主体审计整改，2026-09-22）：`SPECIFIER_PATTERNS` 的 `from`
 * 形式带 `^[ \t]*` 行首锚点，而行注释 `// import …` 的行首是 `/` 不是 `import`，未剥注释时本来
 * 就不在候选集里。用行注释做这条负例，`stripComments` 改成恒等也不会报红——夹具只验证了「捞出」
 * 那半条。块注释的中间行行首正是 `import`：未剥注释时会被捞出（`SCANNER_FIXTURE_COMMENTED` 钉住
 * 这一点），剥掉后才消失，两半缺一不可。
 *
 * 夹具按行以字符串字面量拼成，源码里 `import` 前面始终有引号，因此不会被本文件的真实扫描误判引用。
 */
const SCANNER_FIXTURE = [
  'import { x } from "@server/db/schema";',
  "/*",
  'import { y } from "@server/db/in-block-comment";',
  "*/",
  "const z = 1;",
].join("\n");

/** 夹具里那条藏在块注释中的形似导入：未剥注释时会被 `extractSpecifiers` 一并捞出。 */
const SCANNER_FIXTURE_COMMENTED = "@server/db/in-block-comment";

/**
 * RMD-03 迁移映射（宿主旧路径 → 包内新 owner 路径）。
 *
 * 记成「一对」而不是两份清单：旧路径残留（第二份实现复活）与新路径缺失是同一次迁移失败的两种
 * 表现，成对记录才能让失败信息同时指出两端。
 *
 * 注意 `apps/web/src/routes/admin/sandbox.tsx` 保留在宿主是既定分工（WebShell 薄 route adapter，归 §1.6），
 * 不在本清单里，不要当成残留删除。它旁边的 `apps/web/src/__tests__/system-sandbox.test.ts` 则是**反向**约束：
 * 该测试已随 RMD-08 迁入本包（`web/__tests__/system-sandbox.test.ts`），宿主路径不得复活——
 * `scripts/__tests__/rmd-08-migration.test.ts` 正向断言宿主两份旧路径都不存在、包内唯一落点存在。
 */
const MIGRATION_PAIRS: ReadonlyArray<readonly [hostPath: string, packagePath: string]> = [
  ["apps/server/src/routes/api/sandbox.ts", "src/server/routes/api/sandbox.ts"],
  ["apps/server/src/routes/api/sandbox-cluster.ts", "src/server/routes/api/sandbox-cluster.ts"],
  ["apps/server/src/routes/api/sandbox-server.ts", "src/server/routes/api/sandbox-server.ts"],
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

/**
 * 路由模块：`src/server/routes/**` 下导出 `create*Routes` 工厂的文件（去掉扩展名的绝对路径）。
 *
 * 只认工厂导出，因为 `routes/dependencies.ts` 只放注入用的类型，被各 route 导入是设计内行为；
 * 把它算进来会让「route 之间不得互相依赖」的断言对合法用法误报。
 */
const routeModuleBases = new Set(
  filesUnder("src/server/routes")
    .filter((file) => /export function create\w*Routes/.test(readFileSync(file, "utf8")))
    .map((file) => file.replace(/\.tsx?$/, "")),
);

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
    // `db/**` 也必须被钉住：它是本包表定义的落点，一旦从 `SOURCE_ENTRIES` 掉出去，往 `db/schema.ts`
    // 插一条真宿主导入不会有任何断言报红——「本包确实扫不到」与「db/ 根本没进扫描集」就分不开了
    // （B4 主体审计发现，2026-09-22；`sourceFiles.length` 的阈值比实际文件数低 20 余，兜不住单目录缺失）。
    for (const expected of [
      "fenix.module.ts",
      "db/schema.ts",
      "src/server.ts",
      "src/server/routes/api/sandbox.ts",
      "src/server/routes/api/sandbox-cluster.ts",
      "src/server/routes/api/sandbox-server.ts",
      "src/server/routes/web/sandbox-pools.ts",
      "src/__tests__/guard-stubs.ts",
      "web/index.ts",
      "web/src/api/system-sandbox.ts",
      "web/src/pages/admin/AdminSandboxPage.tsx",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(60);
    // 扫描器自检（负例夹具）分两半，缺一不可：
    //   1) 未剥注释时，块注释里的形似导入**必须**被捞出——证明夹具本身有区分力，而不是「恰好扫不到」；
    //   2) 剥掉注释后只剩真实导入——证明 `stripComments` 真的在起作用。
    expect(extractSpecifiers(SCANNER_FIXTURE)).toEqual(["@server/db/schema", SCANNER_FIXTURE_COMMENTED]);
    expect(extractSpecifiers(stripComments(SCANNER_FIXTURE))).toEqual(["@server/db/schema"]);
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

  // 宿主实现只能经平台契约（`@fenix/platform-sdk`）或注入进入本包；§1.7 B4 之后**零容忍**。
  test("包内不存在任何宿主 @server 导入", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@server/"));
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

  // route 只做协议适配（§1.3(2)）：route 之间互相 import 会把协议实现耦合成网状，共享逻辑
  // （例如错误映射）必须落在 `routes/` 之外。此前 `sandbox-server` 从 `sandbox-cluster` 取
  // `mapSandboxClusterAdminError`，就是这条断言要挡住的形状。
  test("路由模块之间不存在相互依赖边", () => {
    // 正向控制：路由模块集合为空时下面的断言恒真，先钉住规模（本包当前 4 个路由工厂）。
    expect(routeModuleBases.size).toBeGreaterThanOrEqual(4);
    const offenders = refs.filter((ref) => {
      if (!routeModuleBases.has(ref.file.replace(/\.tsx?$/, ""))) return false;
      if (!ref.specifier.startsWith(".")) return false;
      return routeModuleBases.has(resolve(dirname(ref.file), ref.specifier));
    });
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

  // 只断言「目标存在」会漏掉**键被删掉**这一半（W1 变异测试实测：删掉 `exports["./server"]` 后
  // 本文件仍全绿）。因此这里逐个键断言存在 + 目标路径，每条都对应一个真实消费方：
  //   `.`、`./server`、`./module` 是计划 §2.2 的交付物契约；`./server/testing` 由 machine 包的
  //   `server/testing` 子路径与宿主 `test-utils/setup-mocks.ts` 消费；
  //   `./web/i18n` 由宿主 `apps/web/src/i18n/index.ts` 消费；`./web` 由 observer / model-management /
  //   agent-config 的 web 面消费。
  test("package.json 的 exports 键齐备且指向约定文件", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["./module", "./fenix.module.ts"],
      ["./server", "./src/server.ts"],
      ["./server/testing", "./src/server/testing.ts"],
      ["./web", "./web/index.ts"],
      ["./web/i18n", "./web/i18n/index.ts"],
    ];
    for (const [key, target] of expected) {
      expect(manifest.exports?.[key], `exports 缺少 ${key}`).toBe(target);
    }
    // 根入口必须存在，且不得是浏览器入口：包根被服务端与装配层导入，指向 `web/**` 会把整张
    // 浏览器图（React、Radix、页面）拖进模块注册与装配路径。
    expect(typeof manifest.exports?.["."]).toBe("string");
    expect(manifest.exports?.["."]?.startsWith("./web/")).toBe(false);
  });

  // README 是 §1 静态条件 6 的交付物，但「文件存在」不等于「五段式非占位」——W1 变异测试实测：
  // 换成单行占位后本文件仍全绿。这里把结构与体量钉住，缺段或退化成占位会在包内直接失败。
  test("README 为五段式且非占位", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    expect(readme.startsWith("# @fenix/resource-sandbox")).toBe(true);
    const headings = readme.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## 定位与 owner", "## 服务端交付物", "## web 面与 i18n", "## 边界残留", "## 已知项"]);
    const bodyLines = readme.split("\n").filter((line) => line.trim().length > 0);
    expect(bodyLines.length).toBeGreaterThanOrEqual(40);
    expect(readme).not.toMatch(/TODO|待补|占位/);
  });

  // 跨包只能走对方根入口的公开导出；深入 `@fenix/*/src` 会把别的包的内部实现拖进本包依赖面。
  test("跨包引用不深入其他包的 src 内部路径", () => {
    const offenders = refs.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });
});
