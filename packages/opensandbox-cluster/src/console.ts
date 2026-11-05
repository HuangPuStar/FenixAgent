import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Elysia } from "elysia";
import { createSkillDownloadRoutes } from "./skill-downloads";

/** Serve only the login shell and generated assets; all data remains behind authenticated APIs. */
export function createConsoleRoutes(root = fileURLToPath(new URL("../dist/web/", import.meta.url))) {
  const serve = async (name: string, asset = false) => {
    const file = Bun.file(join(root, name));
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    return new Response(file, {
      headers: {
        "Content-Type": file.type,
        "Cache-Control": asset ? "public, max-age=31536000, immutable" : "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      },
    });
  };
  return new Elysia({ name: "cluster-console" })
    .use(createSkillDownloadRoutes())
    .get("/", () => serve("index.html"))
    .get("/assets/:file", ({ params }) =>
      /^[A-Za-z0-9_-]+\.(js|css)$/.test(params.file)
        ? serve(`assets/${params.file}`, true)
        : new Response("Not Found", { status: 404 }),
    );
}
