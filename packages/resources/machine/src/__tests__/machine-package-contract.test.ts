// packages/resources/machine/src/__tests__/machine-package-contract.test.ts
// Machine 的**包边界契约测试**（任务 1.3 §1 静态条件）。
//
// 命名：本文件由 `machine-source-migration.test.ts` 就地改写而来（RMD-02 的迁移记录断言保留在下方），
// 改名为 `*-package-contract.test.ts` 与 prod-view 的同级契约测试对齐——验收按 `package-contract` 定位本包
// 的静态条件守护，旧名字只会让人再去翻一个只剩文件存在性断言的「假绿」文件。
//
// 为什么重写为引用面断言：旧版本只断言「某个路径存在文件」与「包入口有这些导出名」——计划 §7 风险 3
// 点名的「假绿」实例：它检不出 §1 条件 3 的 11 处宿主穿透（5 个 web 测试文件以六级相对路径 import
// `apps/web`，其中 2 处是运行时动态 import），而条件 3 正是包能否离开宿主解析环境独立构建的前提。
//
// 扫描口径与 `packages/resources/sandbox` 的同名契约测试一致：先剥注释（注释会举例写出宿主路径，
// 直接匹配会误报），再取 import/export 说明符（`import type` 与动态 `import()` 同样计入——它们同样把
// 宿主路径写进包内）。测试文件也在扫描范围内：本次条件 3 的 11 处命中全部落在测试文件里，豁免测试
// 等于把断言变成摆设。本文件只读文件、不 import 被测模块（唯一例外是第 1 条导出面断言），因此不会把
// 被测代码的副作用带进来。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/machine`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 仓库根；旧路径与新 owner 路径都以它为基准记录。 */
const REPO_ROOT = resolve(PKG_ROOT, "../../..");
/** 包内源码入口；README 等文档里的示例不属于可解析引用，不参与扫描。 */
const SOURCE_ENTRIES = ["src", "web", "db", "fenix.module.ts"];

/**
 * 唯一允许的宿主导入。
 *
 * 表定义迁出归任务 1.7，本任务把它作为**显式残留**保留（README「边界残留」），且只允许这一条精确
 * 路径：`@server/db/schema` 之下的任何深路径都意味着重新伸手取宿主内部。
 */
const ALLOWED_HOST_IMPORT = "@server/db/schema";

/** `readdirSync` 的递归遍历跳过 `node_modules`（包内软链指向别的包的实现，不是本包源码）。 */
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

/** 测试文件：用 `process.env` 搭建夹具属既有做法，条件 4 约束的是实现面。 */
const isTestFile = (file: string) => file.includes("/__tests__/");

/** web 贡献的已扫描文件；宿主别名只可能在 web 面出现，作用域断言按这个集合收敛。 */
const webFiles = new Set(filesUnder("web"));

/** 相对说明符是否落在包外：`resolve` 折叠 `..` 段，宿主与兄弟资源包都会在这里现形。 */
function escapesPackage(file: string, specifier: string): boolean {
  return !resolve(dirname(file), specifier).startsWith(`${PKG_ROOT}/`);
}

const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
  exports?: Record<string, string>;
  name?: string;
};
const exportEntries = Object.entries(manifest.exports ?? {});

/** 路由目录：文件之间只允许共享 `dependencies.ts` 的依赖类型，不得互相导入业务逻辑。 */
const routeFiles = filesUnder("src/server/routes");
const ROUTE_DEPENDENCIES = resolve(PKG_ROOT, "src/server/routes/dependencies.ts");

/**
 * 跨包说明符的目标包 `package.json`。
 *
 * 依赖由 bun workspace 软链进本包 `node_modules`，devDependencies 与未声明的包只在仓库根可见，
 * 因此两处都查；都查不到即说明依赖没声明（或名字写错），本身就是边界违规。
 */
function findTargetManifest(pkgName: string): { exports?: unknown } | null {
  for (const base of [join(PKG_ROOT, "node_modules"), join(REPO_ROOT, "node_modules")]) {
    const candidate = join(base, pkgName, "package.json");
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8")) as { exports?: unknown };
  }
  return null;
}

/** 某条跨包说明符是否命中对方声明的出口（`exports` 为字符串时只允许包根）。 */
function declaredByTarget(target: { exports?: unknown }, subpath: string): boolean {
  const declared = target.exports;
  if (typeof declared === "string") return subpath === ".";
  if (!declared || typeof declared !== "object") return false;
  const keys = Object.keys(declared as Record<string, unknown>);
  if (keys.includes(subpath)) return true;
  // 通配出口（`./web/*` 之类）按前缀判定：写死深路径不违规的前提是对方明确声明了该族。
  return keys.some((key) => key.endsWith("/*") && subpath.startsWith(key.slice(0, -1)));
}

describe("Machine 包边界契约（任务 1.3 §1 静态条件）", () => {
  // 迁移后的公开 server 入口必须同时提供路由工厂、schema 与服务能力。
  // 路由以工厂形式导出（认证守卫由宿主注入）：导出实例会让守卫无法与宿主的认证解析同源。
  test("包入口公开已迁移的文件能力", async () => {
    const server = await import("@fenix/resource-machine/server");

    expect(typeof server.createWebFsRoutes).toBe("function");
    expect(typeof server.createWebFileEventsRoutes).toBe("function");
    expect(typeof server.createWebRegistryRoutes).toBe("function");
    expect(typeof server.createApiWorkspaceRoutes).toBe("function");
    expect(server.FileEventsSubscribeSchema).toBeDefined();
    expect(server.LocalNodeAwareService).toBeDefined();
    // 宿主 seam 的公开入口：装配层经 `bindMachineHostPort` / `bindMachineEnvironmentPort` 注入运行态，
    // sandbox 模块经 `bindMachineSandboxRoutePort` 注入路由判定。三者取代了 1.4 收敛前的反向导入。
    expect(typeof server.bindMachineHostPort).toBe("function");
    expect(typeof server.bindMachineEnvironmentPort).toBe("function");
    expect(typeof server.bindMachineSandboxRoutePort).toBe("function");
  });

  // 遍历有效性自检：walker 若漏掉目录，后续「不存在违规引用」的断言会成片退化为恒真。
  test("扫描有效性自检：源码集合覆盖全包，且已知残留宿主导入能被扫到", () => {
    for (const expected of [
      "fenix.module.ts",
      "src/server.ts",
      "src/server/routes/api/workspaces.ts",
      "src/server/routes/web/file-events.ts",
      "src/server/services/registry.ts",
      "src/server/services/machine-sandbox-projection.ts",
      "src/__tests__/guard-stubs.ts",
      "web/index.ts",
      "web/api/registry.ts",
      "web/__tests__/machine-browser-surface.test.ts",
      "web/src/__tests__/file-picker-dialog.test.tsx",
      "web/src/__tests__/file-tree-dialog.test.tsx",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(80);
    // 正向控制：表定义残留必然存在，扫不到就说明说明符提取失效，而不是「没有宿主导入」。
    // 残留按外键拓扑序逐批迁出（§1.7 表定义迁出），这里同步收缩成精确列表：本包自己的
    // `machine` / `registry_event` 已迁至 `./db`，只剩跨模块表读取——`agent_config`（owner
    // agent-config）与 `sandbox_instance`（owner sandbox），两张表都尚未迁出。
    // 最后一个表定义迁完时，连这条正向控制一起删除（届时本包应零 `@server` 导入）。
    expect(
      refs
        .filter((ref) => ref.specifier === ALLOWED_HOST_IMPORT)
        .map((ref) => relative(PKG_ROOT, ref.file))
        .sort(),
    ).toEqual([
      "src/__tests__/registry-schema.test.ts",
      "src/server/services/machine-sandbox-projection.ts",
      "src/server/services/registry.ts",
    ]);
  });

  // RMD-02 完成后宿主与包内旧路径都不能保留 Machine/File 的同名实现或兼容垫片。
  // 路径一律写成仓库相对路径：迁移前的相对写法（`src/...`）实际指向仓库根下的同名目录，恒不存在，
  // 断言永远为真——那是假绿，不是保护。
  test("Machine/File 旧路径已删除", () => {
    for (const path of [
      // 宿主侧：物理迁移后不得保留同名路由 / schema / 服务实现
      "apps/server/src/routes/api/workspaces.ts",
      "apps/server/src/routes/web/fs.ts",
      "apps/server/src/routes/web/registry.ts",
      "apps/server/src/routes/web/file-events.ts",
      "apps/server/src/schemas/file.schema.ts",
      "apps/server/src/schemas/file-events.schema.ts",
      "apps/server/src/schemas/registry.schema.ts",
      "apps/server/src/services/event-service.ts",
      "apps/server/src/services/local-node-service.ts",
      // 包内：路由目录统一到 §2.3 的 src/server/routes/**，旧 src/routes/** 不得残留第二份
      "packages/resources/machine/src/routes/api/workspaces.ts",
      "packages/resources/machine/src/routes/web/fs.ts",
      "packages/resources/machine/src/routes/web/registry.ts",
      "packages/resources/machine/src/routes/web/file-events.ts",
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path))).toBeFalse();
    }
  });

  // 物理迁移必须落到清单规定的 Machine 目录；仅删除旧文件会破坏测试归属与可追溯性。
  test("Machine/File 文件均落在规定的新 owner 路径", () => {
    for (const path of [
      "packages/resources/machine/src/server/routes/api/workspaces.ts",
      "packages/resources/machine/src/server/routes/web/fs.ts",
      "packages/resources/machine/src/server/routes/web/registry.ts",
      "packages/resources/machine/src/server/routes/web/file-events.ts",
      "packages/resources/machine/src/schemas/file.schema.ts",
      "packages/resources/machine/src/schemas/file-events.schema.ts",
      "packages/resources/machine/src/schemas/registry.schema.ts",
      "packages/resources/machine/src/services/local-node-service.ts",
      "packages/resources/machine/src/__tests__/fs-symlink-escape.test.ts",
      "packages/resources/machine/src/__tests__/fs-upload-escape.test.ts",
      "packages/resources/machine/src/__tests__/local-node-service.test.ts",
      "packages/resources/machine/src/__tests__/machine-resource-surface.test.ts",
      "packages/resources/machine/src/__tests__/machine-sandbox-projection.test.ts",
      "packages/resources/machine/src/__tests__/registry-filews-cleanup.test.ts",
      "packages/resources/machine/src/__tests__/registry-machine-stages.test.ts",
      "packages/resources/machine/src/__tests__/registry-routes-isolation.test.ts",
      "packages/resources/machine/src/__tests__/registry-routes.test.ts",
      "packages/resources/machine/src/__tests__/registry-schema.test.ts",
      "packages/resources/machine/src/__tests__/registry-service.test.ts",
      "packages/resources/machine/src/__tests__/round19-registry-service-boundaries.test.ts",
      "packages/resources/machine/src/__tests__/round36-registry-service-coverage.test.ts",
      "packages/resources/machine/src/__tests__/round39-registry-service.test.ts",
      "packages/resources/machine/src/__tests__/round68-registry-heartbeat.test.ts",
      "packages/resources/machine/web/src/__tests__/file-icon-and-card-registry-pure.test.ts",
      "packages/resources/machine/web/src/__tests__/file-icon-helper-round39.test.ts",
      "packages/resources/machine/web/src/__tests__/file-picker-dialog.test.tsx",
      "packages/resources/machine/web/src/__tests__/file-picker-round49-pure.test.ts",
      "packages/resources/machine/web/src/__tests__/file-tree-dialog.test.tsx",
      "packages/resources/machine/web/src/__tests__/file-tree-model.test.ts",
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path))).toBeTrue();
    }
  });

  // 宿主实现只能经平台契约（`@fenix/platform-sdk`）或注入进入本包；除表定义残留外一律违规。
  test("包内不存在表定义以外的宿主 @server 导入", () => {
    const offenders = refs.filter(
      (ref) => ref.specifier.startsWith("@server") && ref.specifier !== ALLOWED_HOST_IMPORT,
    );

    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 宿主别名（`@/src`、`@/components`）由 apps/web 的 tsconfig/vite 提供，包离开宿主就解析不了。
  test("包内 web 不引用宿主别名 @/", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@/") && webFiles.has(ref.file));

    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 相对路径是最隐蔽的越界方式：指向 `apps/web/**` 的六级相对路径在宿主内能跑通，包单独构建时目录不存在。
  // 这条是 §1 条件 3 的常驻守护——W2 实测 5 个 web 测试文件 / 11 处命中（含 2 处动态 import）即由此现形。
  test("包内不存在穿透到包外的相对路径引用", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith(".") && escapesPackage(ref.file, ref.specifier));

    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 环境变量读取与校验统一在宿主：包内直读 `process.env` 会把部署知识复制进资源模块，两处默认值会分歧。
  // 标题刻意不写该字面量——本文件也在扫描范围内，标题会被自己扫成违规。
  test("包内 src 生产代码不直读宿主环境变量", () => {
    const productionFiles = filesUnder("src").filter((file) => !isTestFile(file));
    const testFiles = filesUnder("src").filter(isTestFile);
    const offenders = productionFiles.flatMap((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return code
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /\bprocess\.env\b/.test(line))
        .map(({ number }) => `${relative(PKG_ROOT, file)}:${number}`);
    });

    expect(offenders).toEqual([]);
    // 排除面必须真实存在：测试用 `process.env` 注入 WORKSPACE_ROOT 是既有做法（豁免的实现面以外使用）。
    // 若哪天测试也改用注入配置，本条会红——提醒的是「把豁免规则一起删掉」，而不是让它悄悄退化成恒真。
    expect(testFiles.filter((file) => /\bprocess\.env\b/.test(readFileSync(file, "utf8"))).length).toBeGreaterThan(0);
  });

  // 跨包只能走对方声明的出口：`@fenix/x/src/...` 或未声明的深路径会把别的包的内部目录变成事实契约
  // （对方的目录一挪，本包的构建就断）。
  test("跨包说明符均命中对方声明的 exports 出口", () => {
    const offenders = refs.flatMap((ref) => {
      if (!ref.specifier.startsWith("@fenix/")) return [];
      const [scope, name, ...rest] = ref.specifier.split("/");
      const pkgName = `${scope}/${name}`;
      const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`;
      // 自我引用（`@fenix/resource-machine/server`）不走 node_modules 软链，按本包 manifest 判定。
      const target = pkgName === manifest.name ? manifest : findTargetManifest(pkgName);
      if (!target) return [`${describeRef(ref)}：目标包未声明或未安装`];
      if (!declaredByTarget(target, subpath)) return [`${describeRef(ref)}：${pkgName} 未声明出口 ${subpath}`];
      return [];
    });

    expect(offenders).toEqual([]);
  });

  // 一个 route 导入另一个 route 的业务逻辑会让协议入口互相纠缠，也让「谁负责校验」不可判定。
  // `dependencies.ts` 只放依赖类型（宿主注入的守卫与端口），是路由之间唯一允许共享的模块。
  test("路由文件互不导入（dependencies.ts 除外）", () => {
    const offenders: string[] = [];
    for (const ref of refs) {
      if (!routeFiles.includes(ref.file) || !ref.specifier.startsWith(".")) continue;
      const target = resolve(dirname(ref.file), ref.specifier);
      const hit = [target, `${target}.ts`, join(target, "index.ts")].find((candidate) =>
        routeFiles.includes(candidate),
      );
      if (hit && hit !== ref.file && hit !== ROUTE_DEPENDENCIES) offenders.push(describeRef(ref));
    }

    expect(offenders).toEqual([]);
  });

  // exports 是本包对宿主的唯一解析入口，目标写错只在宿主构建/装配时才暴露，这里提前钉住。
  test("package.json 的每条 exports 目标都真实存在", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
    const missing = exportEntries.filter(([, target]) => !existsSync(resolve(PKG_ROOT, target)));

    expect(missing.map(([key, target]) => `${key} → ${target}`)).toEqual([]);
  });

  // 只断言「目标存在」会漏掉**键被删掉**这一半。这里逐个键断言存在 + 目标路径，每条都对应一个真实消费方：
  //   `.`、`./module`、`./server` 是计划 §2.2 的交付物契约；`./server/testing` 由宿主
  //   `test-utils/setup-mocks.ts` 与包内用例消费；`./server/schema` 由宿主 `apps/server/src/schemas/**` 消费；
  //   `./file-ws-*`（4 个）是宿主 `setup-mocks.ts` 的 `mock.module()` 目标——说明符必须能解析，否则替换静默失效；
  //   `./web` 由 agent-config / identity 的组织机器页消费。
  //   本包不建 `./web/i18n`：没有自持命名空间，空壳 ns 会让宿主登记一份没有字典的键表（见 README）。
  //   注意：`./server/schema` 与 `./file-ws-*` 是**待删除**出口（README「边界残留」补丁 3 / 4 落地后消费方消失），
  //   删除时要同步缩减这里与下面 `./server/schema` 的键清单——本断言钉的是「现在被消费的出口」，不是永久契约。
  test("package.json 的 exports 键齐备且指向约定文件", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["./module", "./fenix.module.ts"],
      ["./server", "./src/server.ts"],
      ["./server/schema", "./src/server/schema.ts"],
      ["./server/testing", "./src/server/testing.ts"],
      ["./file-ws-handler", "./src/server/transport/file-ws-handler.ts"],
      ["./file-ws-close-log", "./src/server/transport/file-ws-close-log.ts"],
      ["./file-ws-payload", "./src/server/transport/file-ws-payload.ts"],
      ["./file-ws-requests", "./src/server/transport/file-ws-requests.ts"],
      ["./web", "./web/index.ts"],
    ];
    for (const [key, target] of expected) {
      expect(manifest.exports?.[key], `exports 缺少 ${key}`).toBe(target);
    }
    // 根入口必须存在，且不得是浏览器入口：包根被服务端与装配层导入，指向 `web/**` 会把整张浏览器图
    // （React、页面、api client）拖进模块注册与装配路径。
    expect(typeof manifest.exports?.["."]).toBe("string");
    expect(manifest.exports?.["."]?.startsWith("./web/")).toBe(false);
  });

  // README 是 §1 静态条件 6 的交付物，但「文件存在」不等于「五段式非占位」。
  // 与 sandbox 的差异：本包在五段式之上多三段本包专属内容（守卫注入方式、配置与 DB 读取时机、
  // 1.4 起的宿主运行态端口装配契约），因此这里断言「必需段按序出现 + 额外段在白名单内」，
  // 而不是整份标题等值。
  test("README 含五段式必需章节且非占位", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    const required = ["## 定位与 owner", "## 服务端交付物", "## web 面与 i18n", "## 边界残留", "## 已知项"];
    const extra = ["## 守卫由宿主注入", "## 配置与 DB", "## 宿主运行态端口"];
    const headings = readme.split("\n").filter((line) => line.startsWith("## "));

    expect(readme.startsWith("# @fenix/resource-machine")).toBe(true);
    expect(headings.filter((heading) => required.includes(heading))).toEqual(required);
    expect([...headings].sort()).toEqual([...required, ...extra].sort());
    const bodyLines = readme.split("\n").filter((line) => line.trim().length > 0);
    expect(bodyLines.length).toBeGreaterThanOrEqual(40);
    expect(readme).not.toMatch(/TODO|待补|占位/);
  });
});
