/**
 * Generate TypeScript declaration file for the bundled plugin.
 */

Bun.write(
  "dist/index.d.ts",
  `import type { Plugin } from '@opencode-ai/plugin';

declare const HindsightPlugin: Plugin;

export { HindsightPlugin };
export default HindsightPlugin;
`,
);
