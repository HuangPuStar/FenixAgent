import { buildApplication } from "@stricli/core";
import { command } from "./command.js";

export const app = buildApplication(command, {
  name: "acp-link",
  versionInfo: {
    currentVersion: process.env.ACP_LINK_VERSION || "2.0.0",
  },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
    allowArgumentEscapeSequence: true,
  },
});
