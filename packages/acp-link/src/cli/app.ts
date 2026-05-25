import { createRequire } from "node:module";
import { buildApplication } from "@stricli/core";
import { command } from "./command.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export const app = buildApplication(command, {
  name: "acp-link",
  versionInfo: {
    currentVersion: pkg.version,
  },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
    allowArgumentEscapeSequence: true,
  },
});
