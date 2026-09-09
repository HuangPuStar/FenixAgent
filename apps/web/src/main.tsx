import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyAppBrandToDocument, loadAppBrand } from "../../../web/src/lib/app-brand";
import { installPolyfill } from "../../../web/src/lib/clipboard-polyfill";
import "../../../web/src/i18n";
import "../../../web/src/lib/card-renderer/builtins";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { installRandomUUIDPolyfill } from "../../../web/src/lib/random-uuid-polyfill";
import { installStreamdownTablePatch } from "../../../web/src/lib/streamdown-table-patch";
import { routeTree } from "../../../web/src/routeTree.gen";
import "../../../web/src/index.css";

// 必须在任何业务模块之前执行，确保浏览器兼容补丁与品牌配置在 React 渲染前生效。
installPolyfill();
installRandomUUIDPolyfill();
installStreamdownTablePatch();
await loadAppBrand();
applyAppBrandToDocument();

const router = createRouter({
  routeTree,
  basepath: "/ctrl",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
