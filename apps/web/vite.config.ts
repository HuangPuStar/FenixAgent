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
      "@/components": path.resolve(__dirname, "components"),
      "@/src/i18n/locales": path.resolve(__dirname, "src/i18n/locales"),
      "@/src/i18n": path.resolve(__dirname, "src/i18n"),
      "@/src/api/request": path.resolve(__dirname, "src/api/request.ts"),
      "@/src/api/helpers": path.resolve(__dirname, "src/api/helpers.ts"),
      "@/src/api/api-keys": path.resolve(__dirname, "../../packages/platform/identity/web/api/api-keys.ts"),
      "@/src/api/organizations": path.resolve(__dirname, "../../packages/platform/identity/web/api/organizations.ts"),
      "@/src/api/prod-views": path.resolve(__dirname, "../../packages/resources/prod-view/web/api/prod-views.ts"),
      "@/src/api/agents": path.resolve(__dirname, "../../packages/resources/agent-config/web/api/agents.ts"),
      "@/src/api/sites": path.resolve(__dirname, "../../packages/resources/agent-config/web/api/sites.ts"),
      "@/src/components/agent-panel/AgentSitesCard": path.resolve(
        __dirname,
        "../../packages/resources/agent-config/web/components/agent-panel/AgentSitesCard.tsx",
      ),
      "@/src/components/agent-panel/MountSiteDialog": path.resolve(
        __dirname,
        "../../packages/resources/agent-config/web/components/agent-panel/MountSiteDialog.tsx",
      ),
      "@/src/pages/agent-panel/agent-editor": path.resolve(
        __dirname,
        "../../packages/resources/agent-config/web/pages/agent-panel/agent-editor",
      ),
      "@/src/pages/agent-panel/components/AgentGenerationForm": path.resolve(
        __dirname,
        "../../packages/resources/agent-config/web/pages/agent-panel/components/AgentGenerationForm.tsx",
      ),
      "@/src/pages/agent-panel/pages/AgentSitesPage": path.resolve(
        __dirname,
        "../../packages/resources/agent-config/web/pages/agent-panel/pages/AgentSitesPage.tsx",
      ),
      "@/src/api/skills": path.resolve(__dirname, "../../packages/resources/skill/web/api/skills.ts"),
      "@/src/api/mcp": path.resolve(__dirname, "../../packages/resources/mcp/web/api/mcp.ts"),
      "@/src/api/knowledge-bases": path.resolve(
        __dirname,
        "../../packages/resources/knowledge/web/api/knowledge-bases.ts",
      ),
      "@/src/pages/hindsight/MemoriesPage": path.resolve(
        __dirname,
        "../../packages/resources/memory/web/pages/hindsight/MemoriesPage.tsx",
      ),
      "@/src/types/knowledge": path.resolve(__dirname, "../../packages/resources/knowledge/web/types/knowledge.ts"),
      "@/src/pages/agent-panel/components/knowledge-graph-state": path.resolve(
        __dirname,
        "../../packages/resources/knowledge/web/pages/agent-panel/knowledge-graph-state.ts",
      ),
      "@/src/lib/mcp-resource-access": path.resolve(
        __dirname,
        "../../packages/resources/mcp/web/lib/mcp-resource-access.ts",
      ),
      "@/src/pages/agent-panel/pages/AgentMcpPage": path.resolve(
        __dirname,
        "../../packages/resources/mcp/web/pages/agent-panel/pages/AgentMcpPage.tsx",
      ),
      "@/src/pages/agent-panel/pages/AgentKnowledgeBasesPage": path.resolve(
        __dirname,
        "../../packages/resources/knowledge/web/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx",
      ),
      "@/src/lib/skill-resource-access": path.resolve(
        __dirname,
        "../../packages/resources/skill/web/lib/skill-resource-access.ts",
      ),
      "@/src/pages/agent-panel/pages/AgentSkillsPage": path.resolve(
        __dirname,
        "../../packages/resources/skill/web/pages/agent-panel/pages/AgentSkillsPage.tsx",
      ),
      "@/src/api/models": path.resolve(__dirname, "../../packages/resources/model-management/web/api/models.ts"),
      "@/src/api/environments": path.resolve(__dirname, "../../packages/agent-runtime/web/api/environments.ts"),
      "@/src/pages/agent-panel/pages/AgentTasksPage": path.resolve(
        __dirname,
        "../../packages/resources/task/web/pages/agent-panel/pages/AgentTasksPage.tsx",
      ),
      "@/src/pages/agent-panel/pages/AgentChannelsPage": path.resolve(
        __dirname,
        "../../packages/resources/channel/web/pages/agent-panel/pages/AgentChannelsPage.tsx",
      ),
      "@/src/pages/agent-panel/pages/AgentApiKeysPage": path.resolve(
        __dirname,
        "../../packages/platform/identity/web/pages/agent-panel/pages/AgentApiKeysPage.tsx",
      ),
      // `@/src/pages/agent-panel/pages/AgentOrganizationsPage` 的别名已随 §1.6 T4 删除：
      // 该页需要宿主注入机器注册表（`machineRegistry`），route adapter 必须直连
      // `@fenix/identity/web` 与 `@fenix/resource-machine/web`，别名无法表达这次装配。
      "@/src/pages/admin/AdminLogsPage": path.resolve(
        __dirname,
        "../../packages/resources/observer/web/pages/admin/AdminLogsPage.tsx",
      ),
      "@/src/pages/admin/AdminObserverPage": path.resolve(
        __dirname,
        "../../packages/resources/observer/web/pages/admin/AdminObserverPage.tsx",
      ),
      "@/src/pages/admin/AdminPeoplePage": path.resolve(
        __dirname,
        "../../packages/resources/observer/web/pages/admin/AdminPeoplePage.tsx",
      ),
      "@/src/pages/agent-panel/pages/AgentProdViewsPage": path.resolve(
        __dirname,
        "../../packages/resources/prod-view/web/pages/agent-panel/pages/AgentProdViewsPage.tsx",
      ),
      "@/src/pages/agent-panel/ProdViewsPanel": path.resolve(
        __dirname,
        "../../packages/resources/prod-view/web/pages/agent-panel/ProdViewsPanel.tsx",
      ),
      "@/src/pages/prod-view/ProdViewPage": path.resolve(
        __dirname,
        "../../packages/resources/prod-view/web/pages/prod-view/ProdViewPage.tsx",
      ),
      "@/src/pages/workflow": path.resolve(__dirname, "../../packages/resources/workflow/web/pages/workflow"),
      "@/src/yjs": path.resolve(__dirname, "../../packages/agent-runtime/web/yjs"),
      "@/src/pages/agent-panel/ChatPanel": path.resolve(
        __dirname,
        "../../packages/agent-runtime/web/agent-panel/ChatPanel.tsx",
      ),
      "@/src/lib/card-renderer": path.resolve(__dirname, "src/lib/card-renderer"),
      "@/src/lib/model-config-utils": path.resolve(
        __dirname,
        "../../packages/resources/model-management/web/lib/model-config-utils.ts",
      ),
      "@/src/pages/admin/AdminModelGatewayPage": path.resolve(
        __dirname,
        "../../packages/resources/model-management/web/pages/admin/AdminModelGatewayPage.tsx",
      ),
      "@/src/pages/agent-panel/pages/AgentModelsPage": path.resolve(
        __dirname,
        "../../packages/resources/model-management/web/pages/agent-panel/pages/AgentModelsPage.tsx",
      ),
      "@/src/pages/agent-panel/pages/VerticalModelsPage": path.resolve(
        __dirname,
        "../../packages/resources/model-management/web/pages/agent-panel/pages/VerticalModelsPage.tsx",
      ),
      "@/src/pages/agent-panel/pages/ModelGatewayUsagePage": path.resolve(
        __dirname,
        "../../packages/resources/model-management/web/pages/agent-panel/pages/ModelGatewayUsagePage.tsx",
      ),
      // 身份客户端的唯一实现落在 @fenix/identity/web；这里保留 @/src 别名是因为资源包与
      // agent-runtime 的 web contribution 仍以别名引用它，改直依赖会新增 resource/agent-runtime
      // → platform-impl 的禁止边（见 scripts/lib/architecture-boundary-rules.ts §2.3）。
      "@/src/lib/auth-client": path.resolve(__dirname, "../../packages/platform/identity/web/lib/auth-client.ts"),
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
