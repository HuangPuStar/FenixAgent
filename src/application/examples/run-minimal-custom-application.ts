const EXAMPLE_HOST = "127.0.0.1";

async function runExample(): Promise<void> {
  // better-auth initializes during app import, so provide a non-secret local callback base first.
  process.env.BETTER_AUTH_URL ??= `http://${EXAMPLE_HOST}`;
  const { createCommunityMinimalExampleApplication } = await import("./minimal-custom-application");
  const runtime = createCommunityMinimalExampleApplication({
    config: {
      version: "app-builder-example",
      wsMaxPayloadMb: 1,
    },
    startedAt: new Date().toISOString(),
  });

  try {
    await runtime.start({ hostname: EXAMPLE_HOST, port: 0 });
  } catch (error) {
    console.error("App Builder example failed to start", error);
    process.exitCode = 1;
    return;
  }

  const url = `http://${EXAMPLE_HOST}:${runtime.app.server?.port}/example`;
  console.log(`App Builder example is running\nOpen ${url}\nPress Ctrl+C to stop`);

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      console.log(`Received ${signal}, stopping App Builder example`);
      try {
        await runtime.stop();
      } catch (error) {
        console.error("App Builder example failed to stop", error);
        process.exitCode = 1;
      }
    })();
    return shutdownPromise;
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (import.meta.main) await runExample();
