/**
 * 正文中的 slash 命令移除。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/ChatComposer.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除） 的内部函数
 * `removeSlashCommand`。拆分后由 `ChatComposer.tsx`（技能标签删除）与
 * `composer-handlers.ts`（命令面板选中/取消）共用，避免两份实现漂移。
 * 纯化改动点：无（纯字符串处理）。
 */

/** 从正文中移除某个 slash 命令，并去掉移除后残留的行首空白。 */
export function removeSlashCommand(text: string, commandName: string): string {
  return text
    .split(/(\s+)/)
    .filter((token) => token !== `/${commandName}`)
    .join("")
    .replace(/^\s+/, "");
}
