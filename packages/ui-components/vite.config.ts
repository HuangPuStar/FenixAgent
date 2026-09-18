import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkgRoot = __dirname;

/**
 * 本配置只服务包内 demo（stage 3 的 `demo/`），库产物以源码形式被消费方打包，
 * 因此不做 lib build，dist 仅包含展示页静态资源。
 *
 * alias 使用正则条目而非字符串前缀：字符串前缀别名（"@fenix/ui-components"）在 Vite 的 startsWith
 * 语义下会先吞掉子路径导入，把 `@fenix/ui-components/ui/button` 改写成 `.../web/index.ts/ui/button`；
 * 正则条目在 Vite 与 @rollup/plugin-alias 两种匹配语义下行为一致。
 * `styles.css` 必须排在通配条目之前，否则会被通配规则改写成不存在的 web/styles.css —— 它与
 * package.json exports 的 "./styles.css" 是同一个入口，两者必须保持一致。
 */
export default defineConfig({
  root: pkgRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@fenix\/ui-components\/styles\.css$/, replacement: path.resolve(pkgRoot, "web/styles/theme.css") },
      { find: /^@fenix\/ui-components\/(.*)$/, replacement: `${path.resolve(pkgRoot, "web")}/$1` },
      { find: /^@fenix\/ui-components$/, replacement: path.resolve(pkgRoot, "web/index.ts") },
    ],
  },
  build: {
    outDir: "dist",
  },
  server: {
    port: 5273,
  },
});
