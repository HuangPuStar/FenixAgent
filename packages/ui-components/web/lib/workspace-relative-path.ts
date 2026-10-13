/**
 * 工作区相对路径判定（安全原语）。
 *
 * 用途：在把一条路径送进**文件读取入口**之前做词法校验——聊天消息里的文件引用要打开预览、
 * 「产物预览事件」要按路径取文件，两处都必须先确认这条路径没有逃出 workspace 根。
 *
 * 拒绝的条件（逐条都是越界面，不得放宽）：
 * - 空串；
 * - 以 `/` 开头的绝对路径；
 * - 含控制字符（`U+0000`–`U+001F`、`U+007F`）——防止用 `\0` 之类截断下游路径处理；
 * - 按 `/` 切分后出现空段（`docs//a.txt`）、`.` 或 `..`（`docs/../a.txt`）。
 * 通过即代表每个 `segment` 都是普通名字，拼接在 workspace 根下不会跳出根。
 *
 * 唯一实现。此前有两份逐字相同的副本：`packages/web-runtime/web/lib/artifacts-preview-events.ts`
 * 与本包 `chat/view/MessageBubble.tsx`（后者注释记的出处 `apps/web/src/lib/artifacts-preview-events.ts`
 * 已随迁移删除）。安全判据出现第二份就意味着「收紧一处、另一处照旧放行」，故在
 * 2026-09-22 去重中下沉到此：web-runtime 侧改为从本模块转发（其导出名与子路径不变），
 * MessageBubble 改为直接引用。函数体与两份副本逐字相同，未放宽任何条件。
 *
 * 落点为什么在根 `lib/` 而不在 `chat/lib/`：本函数只有路径词法校验，不含任何聊天协议或消息类型，
 * 消费方也横跨两端（chat 视图 + 产物预览事件总线，后者被应用壳的产物面板使用），
 * 归进 `chat` 分组会把「chat 分组 = Chat UI 体系」这条边界说假。
 */
export function isWorkspaceRelativeFilePath(path: string): boolean {
  if (
    !path ||
    path.startsWith("/") ||
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
