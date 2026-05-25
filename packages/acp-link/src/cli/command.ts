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
    });
  },
});
