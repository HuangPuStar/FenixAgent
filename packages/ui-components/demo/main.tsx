import { createRoot } from "react-dom/client";

import App from "./App";
import { Providers } from "./providers";
import "./demo.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("demo 入口缺少 #root 挂载节点：请检查 index.html");
}

createRoot(container).render(
  <Providers>
    <App />
  </Providers>,
);
