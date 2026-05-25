import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

const srcDir = join(import.meta.dirname, "..");
const src = fs.readFileSync(join(srcDir, "pages/EnvironmentsPage.tsx"), "utf-8");

describe("EnvironmentsPage.tsx UX checks", () => {
  // No alert() calls
  test("does not use alert()", () => {
    expect(src).not.toMatch(/\balert\s*\(/);
  });

  // Uses toast for error reporting
  test("uses toast.error for error reporting", () => {
    expect(src).toContain("toast.error");
  });

  // Import sonner toast
  test("imports toast from sonner", () => {
    expect(src).toContain('from "sonner"');
  });

  // Inline form validation
  test("has formError state for inline validation", () => {
    expect(src).toContain("formError");
  });

  // Secret copy feedback
  test("has secretCopied state for copy feedback", () => {
    expect(src).toContain("secretCopied");
  });

  // Secret copy shows "已复制!" text
  test("secret copy button shows feedback text", () => {
    expect(src).toContain("已复制!");
  });

  // Branded loading spinner
  test("loading state uses branded spinner", () => {
    expect(src).toContain("animate-spin");
    expect(src).toContain("border-brand");
    expect(src).toContain("border-t-transparent");
  });
});
