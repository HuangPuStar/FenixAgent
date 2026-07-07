import { applyAppBrandToDocument, loadAppBrand } from "./lib/app-brand";
import { installPolyfill } from "./lib/clipboard-polyfill";

// 必须在任何其他模块之前执行，确保 streamdown 等第三方库的 copy 调用可正常工作
installPolyfill();

await loadAppBrand();
applyAppBrandToDocument();
await import("./main");
