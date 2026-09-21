const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const packageDirectory = join(__dirname, "packages");

/** 返回现有一级、二级 workspace package 的相对目录。 */
function getWorkspacePackageRoots() {
  return readdirSync(packageDirectory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];

    const packagePath = join(packageDirectory, entry.name);
    if (existsSync(join(packagePath, "package.json"))) {
      return [`packages/${entry.name}`];
    }

    return readdirSync(packagePath, { withFileTypes: true })
      .filter((child) => child.isDirectory() && existsSync(join(packagePath, child.name, "package.json")))
      .map((child) => `packages/${entry.name}/${child.name}`);
  });
}

/** 将 workspace 相对路径转为同时匹配仓库和测试临时目录的正则片段。 */
function workspacePathPattern(path) {
  return `(?:^|/)${path.replaceAll("/", "\\/")}(?:/|$)`;
}

/** 匹配 workspace package 的 src 内部实现目录。 */
function workspaceSourcePathPattern(path) {
  return `(?:^|/)${path.replaceAll("/", "\\/")}/src/`;
}

const workspacePackageRoots = getWorkspacePackageRoots();

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "workspace 模块依赖必须有向无环。违规按「规则 + 包对」登记在架构例外台账中。",
      severity: "error",
      from: { path: "(?:^|/)(?:apps|packages)/" },
      to: { circular: true },
    },
    ...workspacePackageRoots.map((targetRoot) => ({
      name: `no-cross-package-src:${targetRoot}`,
      comment: "跨 package 只能经 package export 导入，不能读取对方 src 实现。",
      severity: "error",
      from: {
        path: "(?:^|/)packages/",
        pathNot: workspacePathPattern(targetRoot),
      },
      to: {
        path: workspaceSourcePathPattern(targetRoot),
        // 必须保留 local：每个合法的 `@fenix/x` 导入都会解析到 packages/x/src/，
        // 去掉该过滤会产生数百条把公开导出误判为内部穿透的假阳性。
        dependencyTypes: ["local"],
      },
    })),
    {
      name: "platform-not-to-agent-runtime-resources-apps",
      comment: "platform 是底层能力，不能依赖 agent-runtime、resources 或 app 装配层。",
      severity: "error",
      from: { path: "(?:^|/)packages/platform/" },
      to: { path: "(?:^|/)(?:packages/(?:agent-runtime|resources)/|apps/)" },
    },
    {
      name: "agent-runtime-not-to-resources",
      comment:
        "agent-runtime 层不能反向依赖资源领域包；Machine/Sandbox 是设计登记的专用运行入口例外。" +
        "`db/**` 按 §6.1 的 schema 组装期例外放行（environment.agent_config_id 是跨模块外键，表对象只能导入），" +
        "src/** 的反向禁则不变。",
      severity: "error",
      from: {
        path: "(?:^|/)packages/agent-runtime/",
        pathNot: "(?:^|/)packages/agent-runtime/db/",
      },
      to: {
        path: "(?:^|/)packages/resources/",
        pathNot: "(?:^|/)packages/resources/(?:machine|sandbox)/",
      },
    },
    {
      name: "ce-not-to-ee",
      comment: "CE 源码不能依赖 @fenix-ee 包。",
      severity: "error",
      from: { path: "(?:^|/)(?:apps|packages|src|web)/" },
      to: { path: "(?:^|/)node_modules/@fenix-ee/" },
    },
  ],
  options: {
    exclude: "(^|/)dist/",
    // 只把 npm 依赖留在图外；workspace 包必须被跟随，否则包间边会静默消失。
    doNotFollow: { path: "node_modules" },
    // 别名表以仓库根 tsconfig.json 为唯一来源；dependency-cruiser 的 paths 以运行目录为基准，
    // 因此门禁必须在仓库根执行（package.json 的 check:dependencies 已保证这一点）。
    // §1.6 T11e 之后这张表只剩宿主自有别名（宿主 `src/`、宿主 i18n 字典、`@server`）：指向
    // `packages/**` 的桥接别名已全部删除，跨包引用一律经各包 `exports`——因此本门禁里出现的
    // `@/src/*` 边必然是宿主内部引用，不再需要区分「宿主自己的文件」与「包内实现」。
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      // 本仓库的 workspace 包只有 exports、没有 main；不声明 exportsFields 会让所有
      // `@fenix/*` 导入解析失败，进而让循环与跨包规则全部静默失效。
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    },
  },
};
