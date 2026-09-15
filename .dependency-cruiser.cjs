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
      comment: "workspace 模块依赖必须有向无环。",
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
      comment: "agent-runtime 层不能反向依赖资源领域包。",
      severity: "error",
      from: { path: "(?:^|/)packages/agent-runtime/" },
      to: { path: "(?:^|/)packages/resources/" },
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
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    },
  },
};
