import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

/** Publish the installed PDF.js resources locally in both Vite development and production. */
export function pdfAssetsPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const { version } = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
  const prefix = `pdfjs/${version}/`;
  const files = new Map<string, string>([["pdf.worker.min.mjs", path.join(packageRoot, "build/pdf.worker.min.mjs")]]);
  for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs", "web/images"])
    for (const entry of readdirSync(path.join(packageRoot, folder), { withFileTypes: true }))
      if (entry.isFile())
        files.set(
          `${folder === "web/images" ? "images" : folder}/${entry.name}`,
          path.join(packageRoot, folder, entry.name),
        );
  return {
    name: "fenix-pdf-assets",
    generateBundle() {
      for (const [name, file] of files)
        this.emitFile({ type: "asset", fileName: prefix + name, source: readFileSync(file) });
    },
    configureServer(server) {
      const urlPrefix = `${server.config.base}${prefix}`;
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0];
        if (!pathname?.startsWith(urlPrefix)) return next();
        const file = files.get(pathname.slice(urlPrefix.length));
        if (!file) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader(
          "Content-Type",
          file.endsWith(".mjs")
            ? "text/javascript"
            : file.endsWith(".wasm")
              ? "application/wasm"
              : "application/octet-stream",
        );
        res.end(readFileSync(file));
      });
    },
  };
}
