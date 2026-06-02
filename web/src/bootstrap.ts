import { applyAppBrandToDocument, loadAppBrand } from "./lib/app-brand";

await loadAppBrand();
applyAppBrandToDocument();
await import("./main");
