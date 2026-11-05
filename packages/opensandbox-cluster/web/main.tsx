import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import "@fenix/ui-components/styles.css";
import { createConsoleRouter } from "./router";

const root = document.getElementById("root");
if (!root) throw new Error("missing root element");
createRoot(root).render(<RouterProvider router={createConsoleRouter()} />);
