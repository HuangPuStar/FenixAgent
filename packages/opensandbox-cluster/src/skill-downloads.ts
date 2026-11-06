import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Elysia } from "elysia";

const SKILL_FILES = {
  "deploy-opensandbox-node": [
    "SKILL.md",
    "references/deployment.md",
    "assets/compose.yaml",
    "assets/direct.yaml",
    "assets/tunnel.yaml",
    "assets/sandbox.toml.example",
  ],
  "use-opensandbox-sandbox": ["SKILL.md", "references/lifecycle.md", "references/access.md"],
} as const;

/** Download portable, credential-free skills using an explicit file allowlist. */
export function createSkillDownloadRoutes(root = fileURLToPath(new URL("../skills/", import.meta.url))) {
  return new Elysia({ name: "cluster-skill-downloads" }).get("/skills/:name/download", async ({ params }) => {
    if (!Object.hasOwn(SKILL_FILES, params.name)) return new Response("Not Found", { status: 404 });
    const name = params.name as keyof typeof SKILL_FILES;
    const entries: Record<string, string> = {};
    for (const file of SKILL_FILES[name]) entries[`${name}/${file}`] = await Bun.file(join(root, name, file)).text();
    const archive = await new Bun.Archive(entries, { compress: "gzip" }).blob();
    return new Response(archive, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${name}.tar.gz"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
