import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dirname, "..", "..");

describe("WorkflowPage", () => {
  test("WorkflowPage component exports correctly", () => {
    const src = readFileSync(join(webRoot, "src/pages/WorkflowPage.tsx"), "utf-8");
    expect(src).toContain("export function WorkflowPage");
  });

  test("iframe src points to /workflow-ui/", () => {
    const src = readFileSync(join(webRoot, "src/pages/WorkflowPage.tsx"), "utf-8");
    expect(src).toContain('src="/workflow-ui/"');
  });

  test("Sidebar contains workflow navigation entry", () => {
    const src = readFileSync(join(webRoot, "src/components/shell/Sidebar.tsx"), "utf-8");
    expect(src).toContain('id: "workflow"');
    expect(src).toContain('label: "工作流"');
    expect(src).toContain("Workflow");
  });

  test("App.tsx includes workflow route", () => {
    const src = readFileSync(join(webRoot, "src/App.tsx"), "utf-8");
    // lazy import
    expect(src).toContain('import("./pages/WorkflowPage")');
    // configViews arrays
    expect(src).toMatch(/configViews.*"workflow"/);
    // ViewId type
    expect(src).toContain('| "workflow"');
    // conditional rendering
    expect(src).toContain('configView === "workflow"');
    expect(src).toContain("<WorkflowPage />");
  });
});
