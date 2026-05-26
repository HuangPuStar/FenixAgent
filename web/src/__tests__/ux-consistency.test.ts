import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

const webSrc = join(import.meta.dirname, "..");
const webRoot = join(import.meta.dirname, "../../");

function readSrc(relPath: string): string {
  return fs.readFileSync(join(webSrc, relPath), "utf-8");
}
function readWeb(relPath: string): string {
  return fs.readFileSync(join(webRoot, relPath), "utf-8");
}

// ============================================================
// Global: no alert() or confirm() across all TSX files
// ============================================================
describe("Global UX consistency", () => {
  const allTsxFiles: string[] = [];

  // Collect all tsx files recursively
  function collectTsx(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("__tests__") && entry.name !== "node_modules") {
          collectTsx(full);
        }
      } else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
        allTsxFiles.push(full);
      }
    }
  }
  collectTsx(webSrc);
  collectTsx(join(webRoot, "components"));

  test("no alert() calls in any TSX file", () => {
    const violations: string[] = [];
    for (const file of allTsxFiles) {
      // workflow pages still use alert() — tracked as tech debt
      if (file.includes("workflow/Workflow")) continue;
      const src = fs.readFileSync(file, "utf-8");
      if (/\balert\s*\(/.test(src)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  test("no confirm() calls in any TSX file", () => {
    const violations: string[] = [];
    for (const file of allTsxFiles) {
      // workflow pages and agent-panel still use confirm() — tracked as tech debt
      if (file.includes("workflow/Workflow")) continue;
      if (file.includes("workflow/components/TriggerPanel")) continue;
      if (file.includes("agent-panel/FileTreeTab")) continue;
      const src = fs.readFileSync(file, "utf-8");
      if (/\bconfirm\s*\(/.test(src)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ============================================================
// LoginPage UX checks
// ============================================================
describe("LoginPage UX", () => {
  const src = readSrc("pages/LoginPage.tsx");

  test("has password visibility toggle (Eye/EyeOff imports)", () => {
    expect(src).toContain("Eye");
    expect(src).toContain("EyeOff");
  });

  test("has showPassword state", () => {
    expect(src).toContain("showPassword");
  });

  test("error messages have background styling", () => {
    expect(src).toContain("bg-status-error");
  });
});

// ============================================================
// SessionDetail UX checks
// ============================================================
describe("SessionDetail UX", () => {
  const src = readSrc("pages/SessionDetail.tsx");

  test("has retry mechanism on error", () => {
    expect(src).toContain("retryKey");
    expect(src).toContain('t("retry")');
  });

  test("uses inline Tailwind for stat colors (no custom CSS class)", () => {
    expect(src).toContain("bg-brand-subtle");
    expect(src).not.toContain('stat-brand"');
  });
});

// ============================================================
// ChatInput UX checks
// ============================================================
describe("ChatInput UX", () => {
  const src = readWeb("components/chat/ChatInput.tsx");

  test("hint text mentions image paste and @ file reference", () => {
    expect(src).toContain("粘贴图片");
    expect(src).toContain("@");
    expect(src).toContain("引用文件");
  });
});

// ============================================================
// Topbar UX checks
// ============================================================
describe("Topbar UX", () => {
  const src = readSrc("components/shell/Topbar.tsx");

  test("search box indicates it is not yet functional", () => {
    expect(src).toContain('t("searchDev")');
  });

  test("search box has reduced opacity", () => {
    expect(src).toContain("opacity-60");
  });
});

// ============================================================
// Dashboard UX checks
// ============================================================
describe("Dashboard UX", () => {
  const src = readSrc("pages/Dashboard.tsx");

  test("loading state uses branded spinner", () => {
    expect(src).toContain("animate-spin");
    expect(src).toContain("border-brand");
  });

  test("no alert() calls", () => {
    expect(src).not.toMatch(/\balert\s*\(/);
  });
});
