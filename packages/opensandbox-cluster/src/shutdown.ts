/** Stop both HTTP hosts before releasing the runtime's durable resources. */
export function createShutdown(
  runtime: { monitor: { stop(): void }; close(): Promise<void> },
  api: { stop(): Promise<unknown> },
  plugin: { stop(): Promise<unknown> },
): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async () => {
      runtime.monitor.stop();
      await Promise.all([api.stop(), plugin.stop()]);
      await runtime.close();
    })();
    return stopping;
  };
}
