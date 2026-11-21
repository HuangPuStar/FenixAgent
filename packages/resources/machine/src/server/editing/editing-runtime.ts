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
  let enabled = configured;
  let reason: string | undefined = configured ? undefined : "not-configured";
  if (configured) {
    const machineId = await getRemoteMachineId(environmentId);
    if (machineId) {
      const capabilities = getFileCapabilities(machineId);
      enabled = capabilities.uploadOverwrite && capabilities.contentVersion;
      if (!enabled) reason = "machine-upgrade-required";
    }
  }
  return {
    textMaxBytes: EDITING_DEFAULTS.textMaxBytes,
    office: {
      enabled,
      extensions: [...OFFICE_EDITABLE_EXTENSIONS],
      maxBytes: EDITING_DEFAULTS.maxFileBytes,
      ...(reason ? { reason } : {}),
    },
  };
}

/** Dispose before host cache/database shutdown; later assembly can create a fresh instance. */
export async function disposeMachineFileEditing(): Promise<void> {
  const current = service;
  service = undefined;
  await current?.dispose();
}
