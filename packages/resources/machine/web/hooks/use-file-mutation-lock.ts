import { useEffect, useRef, useState } from "react";

/** 一次环境内写操作的身份与取消信号，旧任务只能释放自己的锁。 */
export interface FileMutationTask {
  envId: string;
  controller: AbortController;
}

/** 上传和树写操作的同步准入锁；环境切换及卸载立即取消旧任务。 */
export function useFileMutationLock(envId: string | null) {
  const activeRef = useRef<FileMutationTask | null>(null);
  const environmentRef = useRef(envId);
  environmentRef.current = envId;
  const mountedRef = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    setBusy(false);
    return () => {
      mountedRef.current = false;
      const task = activeRef.current;
      if (task?.envId !== envId) return;
      activeRef.current = null;
      task.controller.abort();
    };
  }, [envId]);

  return {
    busy,
    isBusy: () => activeRef.current !== null,
    acquire(): FileMutationTask | null {
      if (!envId || environmentRef.current !== envId || !mountedRef.current || activeRef.current) return null;
      const task = { envId, controller: new AbortController() };
      activeRef.current = task;
      setBusy(true);
      return task;
    },
    isCurrent: (task: FileMutationTask) =>
      activeRef.current === task && environmentRef.current === task.envId && !task.controller.signal.aborted,
    release(task: FileMutationTask) {
      if (activeRef.current !== task) return;
      activeRef.current = null;
      if (mountedRef.current) setBusy(false);
    },
  };
}

/** 可传给同一文件树内所有写入入口的锁。 */
export type FileMutationLock = ReturnType<typeof useFileMutationLock>;
