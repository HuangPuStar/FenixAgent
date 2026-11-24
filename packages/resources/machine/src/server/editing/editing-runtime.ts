import { EDITING_DEFAULTS, EditingError } from "@fenix/file-editing/contracts";
import {
  createEditingService,
  createRedisEditingSessionStorage,
  type EditingRedis,
  type EditingService,
  OFFICE_EDITABLE_EXTENSIONS,
} from "@fenix/file-editing/server";
import { getRedisConnection } from "@fenix/platform-sdk/server";
import { getMachineConfig } from "../config";
import type { MachineFileActor } from "../facades/machine-file-facade";
import { machineFileFacade } from "../facades/machine-file-facade";
import { getRemoteMachineId } from "../services/remote-file-service";
import { getFileCapabilities } from "../transport/file-ws-port";
import { createEditingFileAccess } from "./file-access-adapter";

let service: EditingService | undefined;

/** Lazily construct one editing service for the assembled Machine module. */
export function getMachineEditingService(): EditingService {
  if (service) return service;
  const config = getMachineConfig().fileEditing;
  if (!config) throw new EditingError("unavailable", "Office editing is not configured");
  const redis = getRedisConnection<EditingRedis>();
  service = createEditingService({
    config,
    files: createEditingFileAccess(),
    storage: redis ? createRedisEditingSessionStorage(redis) : undefined,
  });
  return service;
}

/** Capability checks use the authenticated environment and actual file channel, not Agent ACP status. */
export async function getMachineEditingCapabilities(actor: MachineFileActor, environmentId: string) {
  await machineFileFacade.open(actor, environmentId);
  const configured = !!getMachineConfig().fileEditing;
  const machineId = await getRemoteMachineId(environmentId);
  const capabilities = machineId ? getFileCapabilities(machineId) : null;
  const textEnabled = !capabilities || (capabilities.uploadOverwrite && capabilities.contentVersion);
  const reason = textEnabled ? undefined : "machine-upgrade-required";
  return {
    textMaxBytes: EDITING_DEFAULTS.textMaxBytes,
    text: { enabled: textEnabled, ...(reason ? { reason } : {}) },
    office: {
      enabled: configured && textEnabled,
      extensions: [...OFFICE_EDITABLE_EXTENSIONS],
      maxBytes: EDITING_DEFAULTS.maxFileBytes,
      ...(!configured ? { reason: "not-configured" } : reason ? { reason } : {}),
    },
  };
}

/** Dispose before host cache/database shutdown; later assembly can create a fresh instance. */
export async function disposeMachineFileEditing(): Promise<void> {
  const current = service;
  service = undefined;
  await current?.dispose();
}
