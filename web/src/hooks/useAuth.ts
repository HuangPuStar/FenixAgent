import { useCallback, useState } from "react";
import { getUuid, setUuid } from "@/src/api/helpers";

export function useAuth() {
  const [uuid] = useState(() => getUuid());

  const importUuid = useCallback((newUuid: string) => {
    setUuid(newUuid);
  }, []);

  return { uuid, importUuid };
}
