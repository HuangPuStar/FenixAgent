import {
  type EditingCapabilities,
  EditingError,
  type OfficeSession,
  type OfficeSessionStatus,
} from "@fenix/file-editing/contracts";
import type { EditingService } from "@fenix/file-editing/server";
import { getMachineEditingCapabilities, getMachineEditingService } from "../editing/editing-runtime";
import type { MachineFileActor } from "./machine-file-facade";

/** Machine's authenticated application surface for the replaceable editing service. */
export interface MachineFileEditingFacade {
  capabilities(actor: MachineFileActor, environmentId: string): Promise<EditingCapabilities>;
  open(actor: MachineFileActor, environmentId: string, path: string, lang?: string): Promise<OfficeSession>;
  status(actor: MachineFileActor, id: string): Promise<OfficeSessionStatus>;
  save(actor: MachineFileActor, id: string, opId: string): Promise<{ saveId: string }>;
  overwrite(actor: MachineFileActor, id: string): Promise<OfficeSessionStatus>;
  close(actor: MachineFileActor, id: string): Promise<void>;
  discard(actor: MachineFileActor, id: string): Promise<void>;
}

/** Session controls reauthorize through the injected file adapter on every call. */
export function createMachineFileEditingFacade(
  getService: () => EditingService = getMachineEditingService,
): MachineFileEditingFacade {
  return {
    capabilities: getMachineEditingCapabilities,
    async open(actor, environmentId, path, lang) {
      const capability = await getMachineEditingCapabilities(actor, environmentId);
      if (!capability.office.enabled)
        throw new EditingError("unavailable", "Office editing is unavailable for this environment");
      return getService().open(
        { organizationId: actor.organizationId, userId: actor.userId, environmentId },
        path,
        lang,
      );
    },
    status: (actor, id) => getService().status(actor, id),
    save: (actor, id, opId) => getService().save(actor, id, opId),
    overwrite: (actor, id) => getService().overwrite(actor, id),
    close: (actor, id) => getService().close(actor, id),
    discard: (actor, id) => getService().discard(actor, id),
  };
}

/** Default instance carries no actor or per-request mutable state. */
export const machineFileEditingFacade = createMachineFileEditingFacade();
