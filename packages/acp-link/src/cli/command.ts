import { buildCommand, numberParser } from "@stricli/core";
import type { LocalContext } from "./context.js";

export const command = buildCommand({
  docs: {
    brief: "Start the ACP stdio-to-WebSocket bridge",
    fullDescription:
      "Spawns an ACP agent subprocess and bridges its stdin/stdout to a WebSocket server.\n\n" +
      "Use -- to pass arguments to the agent:\n" +
      "  acp-link /path/to/agent -- --verbose --model gpt-4",
  },
  parameters: {
    flags: {
      port: {
        kind: "parsed",
        parse: numberParser,
        brief: "Port to listen on",
        default: "9315",
      },
      host: {
        kind: "parsed",
        parse: String,
        brief: "Host to bind to (use 0.0.0.0 for remote access)",
        default: "localhost",
      },
      "rcs-url": {
        kind: "parsed",
        parse: String,
        brief: "RCS registry URL (e.g. wss://rcs.example.com). When set, acp-link runs in client mode",
        optional: true,
      },
      "rcs-secret": {
        kind: "parsed",
        parse: String,
        brief: "Shared secret for RCS authentication (must match RCS REGISTRY_SECRET)",
        optional: true,
      },
      "tenant-id": {
        kind: "parsed",
        parse: String,
        brief: "Tenant ID for machine visibility scoping",
        optional: true,
      },
      "user-id": {
        kind: "parsed",
        parse: String,
        brief: "User ID for machine visibility scoping",
        optional: true,
      },
      labels: {
        kind: "parsed",
        parse: String,
        brief: "Comma-separated labels for the machine (e.g. production,gpu)",
        optional: true,
      },
    },
    positional: {
      kind: "array",
      parameter: {
        brief: "Agent command and arguments (use -- before agent flags)",
        parse: String,
        placeholder: "command",
      },
      minimum: 0,
    },
  },
  func: async function (
    this: LocalContext,
    flags: {
      port: number;
      host: string;
      "rcs-url"?: string;
      "rcs-secret"?: string;
      "tenant-id"?: string;
      "user-id"?: string;
      labels?: string;
    },
    ...args: readonly string[]
  ) {
    const port = flags.port;
    const host = flags.host;

    // Agent command is required
    if (args.length === 0) {
      console.error("Error: agent command is required");
      process.exit(1);
    }
    const [command, ...agentArgs] = args;
    const cwd = process.cwd();

    // Import and run the server
    const { startServer } = await import("../server.js");
    await startServer({
      port,
      host,
      command: command!,
      args: [...agentArgs],
      cwd,
      rcsUrl: flags["rcs-url"] || process.env.RCS_URL,
      rcsSecret: flags["rcs-secret"] || process.env.RCS_SECRET,
      tenantId: flags["tenant-id"] || process.env.RCS_TENANT_ID,
      userId: flags["user-id"] || process.env.RCS_USER_ID,
      labels: flags.labels
        ? flags.labels
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    });
  },
});
