import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5175,
    proxy: { "/api": "http://127.0.0.1:8080", "/openapi": "http://127.0.0.1:8080", "/skills": "http://127.0.0.1:8080" },
  },
});
