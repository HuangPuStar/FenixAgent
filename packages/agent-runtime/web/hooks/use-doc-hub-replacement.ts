// packages/agent-runtime/web/hooks/use-doc-hub-replacement.ts
// 订阅会话投影的换代版本：load_session 换代时 Chat/Session Doc 被整体替换，展示层据此
// 重新进入 hydrate 门控，避免把旧 Doc 的尾部更新或半成品新投影继续渲染。

import { useCallback, useSyncExternalStore } from "react";
import { getDocHubReplacementVersion, subscribeDocHubReplacement } from "../yjs/doc-hub";

export function useDocHubReplacementVersion(rcsSessionId: string): number {
  const subscribe = useCallback(
    (listener: () => void) => subscribeDocHubReplacement(rcsSessionId, listener),
    [rcsSessionId],
  );
  const read = useCallback(() => getDocHubReplacementVersion(rcsSessionId), [rcsSessionId]);
  return useSyncExternalStore(subscribe, read, read);
}
