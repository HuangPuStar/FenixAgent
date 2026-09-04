import { useEffect, useState } from "react";

/**
 * 仅在 session 首次解析前返回 loading，后台 revalidation 保持现有页面挂载。
 */
export function useInitialSessionLoading(isPending: boolean): boolean {
  const [hasSettled, setHasSettled] = useState(() => !isPending);

  useEffect(() => {
    if (!isPending) {
      setHasSettled(true);
    }
  }, [isPending]);

  return isPending && !hasSettled;
}
