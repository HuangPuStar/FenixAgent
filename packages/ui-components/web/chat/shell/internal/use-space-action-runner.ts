/**
 * space 归属/命名写的统一失败出口。
 *
 * space 数据的权威在宿主：本包只发起写、不持有副本，因此失败时**只提示**（列表随下一次宿主快照收敛）。
 * 动作既可能同步抛错（回调直接 throw），也可能返回 rejected promise（异步写），
 * 两条路径都收敛到这里，避免每处调用点各写一份 try/catch 与 Promise 判定。
 *
 * 唯一的例外是乐观写：拖放落点会先把会话画到目标分组，失败时必须把那份本地状态撤掉，
 * 否则界面会停在一次从未落库的移动上。这类调用点经第三个参数 `onFailure` 回退，
 * 与提示共用一个出口，避免「提示了但没回退」或反过来。
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import type { ChatNotice } from "../chat-interface-types";

/** space 写动作失败提示的 i18n 键（四条共用同一「提示」出口）。 */
export type SpaceActionFailureKey =
  | "chat.components.acpMain.createSpaceFailed"
  | "chat.components.acpMain.renameSpaceFailed"
  | "chat.components.acpMain.assignSpaceFailed"
  | "chat.components.acpMain.moveToSpaceFailed";

/**
 * 返回一个「执行 space 写动作并在失败时提示」的运行器；`action` 为 undefined（回调未注入）时静默跳过。
 *
 * @param onNotice 运行时提示出口（与 `ACPMain` / `SidebarSessionList` 同一出口）
 */
export function useSpaceActionRunner(onNotice?: (notice: ChatNotice) => void) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  return useCallback(
    (failureKey: SpaceActionFailureKey, action: (() => void | Promise<void>) | undefined, onFailure?: () => void) => {
      if (!action) return;
      const notifyFailure = (error: unknown) => {
        onNotice?.({
          level: "error",
          message: t(failureKey, { message: error instanceof Error ? error.message : "" }),
        });
        // 回退与提示同源：调用方的乐观状态只有在这一个失败出口里撤销，两条路径不会各自漂移。
        onFailure?.();
      };
      try {
        const result = action();
        if (result instanceof Promise) void result.catch(notifyFailure);
      } catch (error) {
        notifyFailure(error);
      }
    },
    [onNotice, t],
  );
}
