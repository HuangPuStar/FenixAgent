import { applyAppBrandToDocument, loadAppBrand } from "./lib/app-brand";
import { installPolyfill } from "./lib/clipboard-polyfill";
import { installStreamdownTablePatch } from "./lib/streamdown-table-patch";

// 必须在任何其他模块之前执行，确保 streamdown 等第三方库的 copy 调用可正常工作
installPolyfill();

// 修复 streamdown 表格最大化后下载/复制按钮无响应
installStreamdownTablePatch();

await loadAppBrand();
applyAppBrandToDocument();
await import("./main");
