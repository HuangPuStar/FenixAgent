import type { ModuleManifest } from "@fenix/platform-sdk";
import { createDefaultAccessControl } from "./src/index";

export const moduleManifest = {
  id: "access-control",
  kind: "access-control",
  dependsOn: [],
  capabilities: ["platform.access-control"],
  create: () => createDefaultAccessControl(),
} satisfies ModuleManifest;
