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

import hindsight from "@vectorize-io/opencode-hindsight";

// The opencode CLI uses namespace import for npm packages.
// This wrapper ensures the plugin function is always the default export.
const wrappedPlugin = async (input: any, options?: Record<string, unknown>) => {
  try {
    const plugin =
      typeof hindsight === "function" ? hindsight : ((hindsight as any).default ?? (hindsight as any).HindsightPlugin);
    return await plugin(input, options ?? {});
  } catch (e: any) {
    console.error("[Hindsight] Failed to initialize:", e?.message ?? String(e));
    return {};
  }
};

export default wrappedPlugin;
export { wrappedPlugin as HindsightPlugin };
