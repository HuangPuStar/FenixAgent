/**
 * Skill 的内容与下载入口（窄出口）。
 *
 * 供两类调用方使用：需要读写 Skill 文档与归档的系统路径（builtin 同步把 `references/` 等额外文件
 * 复制进技能目录后重建归档），以及需要构造下载链接/直接流式读取归档的宿主代码（launch spec 构建）。
 * 它们只需要文件系统与令牌能力，不应该被迫经 `./server` barrel 导入——barrel 会连带导出 HTTP 路由，
 * 把 elysia 端点与宿主服务拉进调用方的依赖图，从而在宿主与资源包之间形成环。
 */

/**
 * 路径解析（`config.skillDir` 的唯一读取处）。
 *
 * 只导出路径与根目录，不导出 `skill-content` 的导入/写入编排：那些是资源包内部的应用流程，调用方要
 * 写资源行就必须走系统路径（`SkillSystemApi`），直接调底层编排会绕过资源行与回滚。
 */
export { getGlobalSkillsDir, skillContentPath, skillSourceDir } from "./server/services/skill-content";
export * from "./server/services/skill-download-token";
export * from "./server/services/skill-fs";
