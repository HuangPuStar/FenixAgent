import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * CE 默认 WebShell 的静态装配描述符。
 *
 * Shell 是应用级组合而不是资源模块，因此它位于 `apps/web` 而不是 `packages/`；server 侧永远
 * 不会实例化它。任务 1.6 会在 `apps/web/src/shell/` 落地真正的 DefaultAppShell 实现并消费
 * 本描述符；在那之前本文件只用于让 `deploy/assembly/ce.json` 的 `webShell` 绑定可被校验。
 *
 * 本文件必须保持为纯元数据：只允许 `import type`（编译期擦除），不得出现值导入或再导出。
 * 生成的 module registry 会以相对路径导入它，任何运行时代码都会把浏览器依赖拖进 server 的
 * 装配图；生成器会断言这一点。
 */
export const moduleManifest = {
  id: "default",
  kind: "web-shell",
  dependsOn: [],
  capabilities: ["web.shell.default"],
} satisfies ModuleManifest;
