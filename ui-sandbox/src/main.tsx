import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/primitives.css";
import "./styles/home-pages.css";
import "./styles/resource-pages.css";
import "./styles/knowledge-bases.css";
import "./styles/models-page.css";
import "./styles/models-catalog.css";
import "./styles/models-dialogs.css";
import "./styles/mcp-marketplace.css";
import "./styles/mcp-plugin-cards.css";
import "./styles/operation-pages.css";
import "./styles/schedule-timeline.css";
import "./styles/admin-pages.css";
import "./styles/access-pages.css";
import "./styles/resource-scope-filter.css";
import "./styles/design-templates.css";
import "./styles/design-template-layouts.css";
import "./styles/design-template-feedback.css";

const root = document.getElementById("root");
if (!root) throw new Error("UI Sandbox root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
