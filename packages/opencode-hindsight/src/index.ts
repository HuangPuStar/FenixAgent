/**
 * Hindsight memory plugin for OpenCode
 *
 * Bundles @vectorize-io/opencode-hindsight with a compatibility wrapper
 * for OpenCode CLI's plugin loading mechanism.
 *
 * Configuration (in priority order):
 *   1. opencode.json plugin options
 *   2. Environment variables (HINDSIGHT_API_URL, HINDSIGHT_API_TOKEN, HINDSIGHT_BANK_ID, etc.)
 *   3. ~/.hindsight/opencode.json
 *   4. Plugin defaults
 *
 * See https://github.com/vectorize-io/hindsight
 */

import type { Plugin } from "@opencode-ai/plugin";
import hindsight from "@vectorize-io/opencode-hindsight";

type PluginModule = {
  default?: Plugin;
  HindsightPlugin?: Plugin;
};

function getPlugin(module: unknown): Plugin | undefined {
  if (typeof module === "function") return module as Plugin;
  if (!module || typeof module !== "object") return;

  const { default: defaultPlugin, HindsightPlugin } = module as PluginModule;
  return defaultPlugin ?? HindsightPlugin;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The opencode CLI uses namespace import for npm packages.
// This wrapper ensures the plugin function is always the default export.
const wrappedPlugin: Plugin = async (input, options) => {
  try {
    const plugin = getPlugin(hindsight);
    if (!plugin) throw new TypeError("Hindsight plugin module has no callable export");
    return await plugin(input, options);
  } catch (error: unknown) {
    console.error("[Hindsight] Failed to initialize:", getErrorMessage(error));
    return {};
  }
};

export default wrappedPlugin;
export { wrappedPlugin as HindsightPlugin };
