/**
 * chat 域命名空间常量。
 *
 * 与字典拆成两个模块（`namespace.ts` 只持常量、`index.ts` 持资源）：`useTranslation(AGENT_CHAT_NS)`
 * 只应把常量拉进模块图，不应把整份字典带进每个消费点的编译单元。
 *
 * 为什么常量在包内而不进 `@fenix/web-runtime/i18n/namespace` 的中心表（§9.2 末尾口径）：中心表只收录
 * **跨包共用**的命名空间；`agentChat` 的键全部由本包实现消费（宿主壳只登记、不持键）。这与 `SANDBOX` 的
 * 既有形态一致——宿主在 `apps/web/src/i18n/index.ts` 从包出口取本常量登记，命名空间归属与字典同源。
 */
export const AGENT_CHAT_NS = "agentChat";
