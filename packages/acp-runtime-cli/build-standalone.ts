import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const targets = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "darwin-arm64": "bun-darwin-arm64",
} as const satisfies Record<string, Bun.Build.CompileTarget>;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { platform: { type: "string" }, outdir: { type: "string" } },
});
if (values.platform && !Object.hasOwn(targets, values.platform)) {
  throw new Error(`Unsupported runtime platform: ${values.platform}`);
}
const outputDirectory = resolve(values.outdir ?? "dist/acp-runtime");
await mkdir(outputDirectory, { recursive: true });
const entrypoints = [resolve(import.meta.dir, "src/bin.ts")];
const bundle = await Bun.build({
  entrypoints,
  target: "bun",
  minify: true,
  outdir: outputDirectory,
  naming: "acp-runtime.js",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Failed to build runtime JavaScript bundle");
console.log(`Built ${resolve(outputDirectory, "acp-runtime.js")}`);

for (const [platform, target] of Object.entries(targets)) {
  if (values.platform && platform !== values.platform) continue;
  const outfile = resolve(outputDirectory, `acp-runtime-${platform}`);
  const result = await Bun.build({
    entrypoints,
    target: "bun",
    minify: true,
    compile: { target, outfile, autoloadBunfig: false },
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build runtime for ${platform}`);
  console.log(`Built ${outfile}`);
}
