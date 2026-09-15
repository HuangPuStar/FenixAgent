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
      "@/components/ui": path.resolve(__dirname, "components/ui"),
      "@/components/chat": path.resolve(__dirname, "../../packages/agent-runtime/web/components/chat"),
      "@/components": path.resolve(__dirname, "../../web/components"),
      "@/src/i18n/locales": path.resolve(__dirname, "../../web/src/i18n/locales"),
      "@/src/i18n": path.resolve(__dirname, "src/i18n"),
      "@/src/api/request": path.resolve(__dirname, "src/api/request.ts"),
      "@/src/api/helpers": path.resolve(__dirname, "src/api/helpers.ts"),
      "@/src/api/models": path.resolve(__dirname, "../../packages/model-management/web/api/models.ts"),
      "@/src/api/providers": path.resolve(__dirname, "../../packages/model-management/web/api/providers.ts"),
      "@/src/api/model-gateway": path.resolve(__dirname, "../../packages/model-management/web/api/model-gateway.ts"),
      "@/src/api/environments": path.resolve(__dirname, "../../packages/agent-runtime/web/api/environments.ts"),
      "@/src/yjs": path.resolve(__dirname, "../../packages/agent-runtime/web/yjs"),
      "@/src/hooks/use-chat-state": path.resolve(__dirname, "../../packages/agent-runtime/web/hooks/use-chat-state.ts"),
      "@/src/hooks/use-session-state": path.resolve(
        __dirname,
        "../../packages/agent-runtime/web/hooks/use-session-state.ts",
      ),
      "@/src/pages/agent-panel/ChatPanel": path.resolve(
        __dirname,
        "../../packages/agent-runtime/web/agent-panel/ChatPanel.tsx",
      ),
      "@/src/pages/agent-panel/chat-auth-state": path.resolve(
        __dirname,
        "../../packages/agent-runtime/web/agent-panel/chat-auth-state.ts",
      ),
      "@/src/pages/agent-panel/chat-visible-reconnect": path.resolve(
        __dirname,
        "../../packages/agent-runtime/web/agent-panel/chat-visible-reconnect.ts",
      ),
      "@/src/pages/agent-panel/session-mutation-refresh": path.resolve(
        __dirname,
        "../../packages/agent-runtime/web/agent-panel/session-mutation-refresh.ts",
      ),
      "@/src/lib/card-renderer": path.resolve(__dirname, "src/lib/card-renderer"),
      "@/src/lib/model-config-utils": path.resolve(
        __dirname,
        "../../packages/model-management/web/lib/model-config-utils.ts",
      ),
      "@/src/lib/model-gateway-usage": path.resolve(
        __dirname,
        "../../packages/model-management/web/lib/model-gateway-usage.ts",
      ),
      "@/src/pages/admin/AdminModelGatewayPage": path.resolve(
        __dirname,
        "../../packages/model-management/web/pages/admin/AdminModelGatewayPage.tsx",
      ),
      "@/src/pages/agent-panel/pages/AgentModelsPage": path.resolve(
        __dirname,
        "../../packages/model-management/web/pages/agent-panel/pages/AgentModelsPage.tsx",
      ),
      "@/src/pages/agent-panel/pages/VerticalModelsPage": path.resolve(
        __dirname,
        "../../packages/model-management/web/pages/agent-panel/pages/VerticalModelsPage.tsx",
      ),
      "@/src/pages/agent-panel/pages/ModelGatewayUsagePage": path.resolve(
        __dirname,
        "../../packages/model-management/web/pages/agent-panel/pages/ModelGatewayUsagePage.tsx",
      ),
      "@/components/config/ModelConfigDialog": path.resolve(
        __dirname,
        "../../packages/model-management/web/components/config/ModelConfigDialog.tsx",
      ),
      "@/components/model-icon": path.resolve(__dirname, "../../packages/model-management/web/components/model-icon"),
      "@/src/lib/auth-client": path.resolve(__dirname, "src/lib/auth-client.ts"),
      "@/src/lib/utils": path.resolve(__dirname, "src/lib/utils.ts"),
      "@/src/lib/random-uuid-polyfill": path.resolve(__dirname, "src/lib/random-uuid-polyfill.ts"),
      "@/src/contexts/OrgContext": path.resolve(__dirname, "src/contexts/OrgContext.tsx"),
      "@/src/lib/theme": path.resolve(__dirname, "src/lib/theme.ts"),
      "@/src": path.resolve(__dirname, "../../web/src"),
      "@server": path.resolve(__dirname, "../../src"),
      "@fenix/chat-channel": path.resolve(__dirname, "../../packages/chat-channel/src/index.ts"),
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
