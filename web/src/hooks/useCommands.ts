import { useEffect, useMemo, useState } from "react";
import type { ACPClient } from "../acp/client";
import type { AvailableCommand } from "../acp/types";

export interface UseCommandsResult {
  commands: AvailableCommand[];
  hasCommands: boolean;
}

/**
 * Hook to manage available commands state.
 * Uses event-driven updates via ACPState EventEmitter.
 */
export function useCommands(client: ACPClient): UseCommandsResult {
  const [commands, setCommands] = useState<AvailableCommand[]>(client.state.availableCommands);

  useEffect(() => {
    const handler = (newCommands: AvailableCommand[]) => setCommands(newCommands);
    client.state.on("availableCommandsChange", handler);
    return () => {
      client.state.off("availableCommandsChange", handler);
    };
  }, [client]);

  const hasCommands = useMemo(() => commands.length > 0, [commands]);

  return { commands, hasCommands };
}
