export const SANDBOX_INSTANCE_STATUSES = [
  "creating",
  "starting",
  "recovering",
  "ready",
  "stopped",
  "deleting",
  "error",
] as const;

export type SandboxInstanceStatus = (typeof SANDBOX_INSTANCE_STATUSES)[number];

export class SandboxProviderNotConfiguredError extends Error {
  constructor(providerKey: string) {
    super(`sandbox provider '${providerKey}' is not configured`);
    this.name = "SandboxProviderNotConfiguredError";
  }
}

export class SandboxInstanceConflictError extends Error {
  constructor(message = "sandbox instance is already being created") {
    super(message);
    this.name = "SandboxInstanceConflictError";
  }
}

export class SandboxRuntimeNotReadyError extends Error {
  constructor(sandboxId: string) {
    super(`sandbox runtime '${sandboxId}' is not ready`);
    this.name = "SandboxRuntimeNotReadyError";
  }
}

export class SandboxStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxStateError";
  }
}
