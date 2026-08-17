import { applyAppBrandToDocument, loadAppBrand } from "./lib/app-brand";
import { installPolyfill } from "./lib/clipboard-polyfill";
import { installRandomUUIDPolyfill } from "./lib/random-uuid-polyfill";
import { installStreamdownTablePatch } from "./lib/streamdown-table-patch";

// 必须在任何其他模块之前执行，确保 streamdown 等第三方库的 copy 调用可正常工作
installPolyfill();

// 必须在任何业务模块之前执行：非 secure context（纯 HTTP）下注入 crypto.randomUUID，
// 使全局调用点在 HTTP / HTTPS 环境下均可正常工作
installRandomUUIDPolyfill();

// 修复 streamdown 表格最大化后下载/复制按钮无响应
installStreamdownTablePatch();

await loadAppBrand();
applyAppBrandToDocument();
await import("./main");
