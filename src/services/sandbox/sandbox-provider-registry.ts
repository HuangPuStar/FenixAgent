import type { SandboxProvider } from "@fenix/sandbox-provider";
import { SandboxProviderNotConfiguredError } from "./sandbox-errors";

export class SandboxProviderRegistry {
  private readonly providers = new Map<string, SandboxProvider>();

  register(key: string, provider: SandboxProvider): void {
    if (this.providers.has(key)) throw new Error(`sandbox provider '${key}' is already registered`);
    this.providers.set(key, provider);
  }

  get(key: string): SandboxProvider {
    const provider = this.providers.get(key);
    if (!provider) throw new SandboxProviderNotConfiguredError(key);
    return provider;
  }
}
