import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  publicDir: path.resolve(__dirname, "public"),
  plugins: [
    TanStackRouterVite({
      routesDirectory: path.resolve(__dirname, "src/routes"),
      generatedRouteTree: path.resolve(__dirname, "src/routeTree.gen.ts"),
      quoteStyle: "double",
    }),
    react(),
    tailwindcss(),
  ],
  base: "/ctrl/",
  resolve: {
    alias: {
      // 只保留宿主自有别名（宿主 `src/`、宿主 i18n 字典、`@server`）。指向 `packages/**` 的桥接别名
      // 已随 §1.6 T11e 全部删除：每个消费方都改直连各包的公开出口（包根 `./web` 或 `./web/lib/*`
      // 窄口），别名只会让「包内实现」在宿主侧有一个永不过期的写法。同批删除的还有根 `tsconfig.json`
      // 里同名的一批 `paths`（两张表必须一致——dependency-cruiser 也读根表）。
      //
      // 保留下来的理由：这些目标就是宿主自己的文件，别名只是缩短相对路径；`@/src/i18n/locales`
      // 必须排在 `@/src/i18n` 之前（vite 按声明顺序取首个匹配），否则字典目录会被 i18n 单例吃掉。
      "@/src/i18n/locales": path.resolve(__dirname, "src/i18n/locales"),
      "@/src/i18n": path.resolve(__dirname, "src/i18n"),
      "@/src/api/helpers": path.resolve(__dirname, "src/api/helpers.ts"),
      "@/src/lib/utils": path.resolve(__dirname, "src/lib/utils.ts"),
      "@/src/lib/random-uuid-polyfill": path.resolve(__dirname, "src/lib/random-uuid-polyfill.ts"),
      "@/src/lib/theme": path.resolve(__dirname, "src/lib/theme.ts"),
      "@/src": path.resolve(__dirname, "src"),
      "@server": path.resolve(__dirname, "../server/src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 10000,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/shiki") || id.includes("node_modules/@shikijs")) {
            return "shiki";
          }
          if (id.includes("node_modules/mermaid")) {
            return "mermaid";
          }
          if (id.includes("node_modules/motion") || id.includes("node_modules/framer-motion")) {
            return "motion";
          }
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "vendor";
          }
          if (id.includes("node_modules/ai/") || id.includes("node_modules/@ai-sdk/")) {
            return "ai-sdk";
          }
          if (id.includes("node_modules/qrcode") || id.includes("node_modules/jsqr")) {
            return "qr";
          }
          if (id.includes("node_modules/@radix-ui")) {
            return "radix-ui";
          }
          if (id.includes("node_modules/@tanstack/react-router") || id.includes("node_modules/@tanstack/router-")) {
            return "tanstack-router";
          }
          if (id.includes("node_modules/@tanstack")) {
            return "tanstack";
          }
          if (id.includes("node_modules/@hookform") || id.includes("node_modules/react-hook-form")) {
            return "hookform";
          }
        },
      },
    },
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
    proxy: {
      "/web": {
        target: "http://localhost:3000",
        changeOrigin: true,
        // Vite 内置 http-proxy 默认会 normalize 请求路径，可能对中文百分号编码做
        // 非预期处理。这里用 configure 钩子覆写 proxyReq.path 保持原始 URL 不变，
        // 确保后端收到的请求和浏览器发出的完全一致。
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.url) {
              proxyReq.path = req.url;
            }
          });
        },
      },
      "/api": "http://localhost:3000",
      "/acp": { target: "http://localhost:3000", ws: true },
    },
  },
});
