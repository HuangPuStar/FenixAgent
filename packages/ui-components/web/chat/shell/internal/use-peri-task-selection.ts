import { useEffect, useState } from "react";
import type { PeriTaskViewProjection } from "../../types";

/** 详情只持有身份：投影更新即时可见，会话切换或任务淘汰后不复活旧选择。 */
export function usePeriTaskSelection(scope: string, tasks: readonly PeriTaskViewProjection[]) {
  const [selection, setSelection] = useState<{ scope: string; id: string } | null>(null);
  const task = selection?.scope === scope ? (tasks.find((item) => item.taskId === selection.id) ?? null) : null;
  useEffect(() => {
    if (selection && (selection.scope !== scope || !tasks.some((item) => item.taskId === selection.id))) {
      setSelection(null);
    }
  }, [scope, tasks, selection]);
  return {
    task,
    select: (item: PeriTaskViewProjection) => setSelection({ scope, id: item.taskId }),
    close: () => setSelection(null),
  };
}
