export interface BridgeStartOptions {
  cwd: string;
  env?: Record<string, string>;
  systemPrompt?: string;
}

export interface BridgeModule {
  prepare(workspace: string, launchSpec: unknown): Promise<void>;
  start(sessionId: string, options: BridgeStartOptions): Promise<{ capabilities: Record<string, unknown> }>;
  sendData(sessionId: string, acpMessage: unknown): Promise<boolean>;
  stop(sessionId: string): Promise<void>;
  on(event: string, callback: (sessionId: string, payload: unknown) => void): void;
}
