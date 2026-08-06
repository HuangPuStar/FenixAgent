import type { SandboxCreateInput, SandboxRef } from "./types";

export interface SandboxProvider {
  create(input: SandboxCreateInput): Promise<SandboxRef>;
  get(providerSandboxId: string, businessSandboxId: string): Promise<SandboxRef | null>;
  resume(providerSandboxId: string, businessSandboxId: string): Promise<SandboxRef>;
  destroy(providerSandboxId: string, businessSandboxId: string): Promise<void>;
}

export class SandboxProviderError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_REQUEST" | "UNAVAILABLE" | "NOT_FOUND" | "REMOTE_ERROR",
    readonly retryable: boolean,
    readonly cause?: unknown,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SandboxProviderError";
  }
}
