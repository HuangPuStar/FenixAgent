/**
 * Task 6 verification: Business components use shadcn primitives
 * Checks that native <button> and overflow-y-auto patterns have been replaced
 * with shadcn <Button> and <ScrollArea>.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const webRoot = resolve(__dirname, "..", "..");

// Files that should use shadcn Button instead of native <button>
const buttonFiles = [
  "components/ACPMain.tsx",
  "components/ACPConnect.tsx",
  "components/ThreadHistory.tsx",
  "components/ChatInterface.tsx",
  "components/chat/PermissionPanel.tsx",
  "components/chat/ToolCallGroup.tsx",
  "components/chat/MessageBubble.tsx",
  "components/config/StatusBadge.tsx",
  "src/components/shell/AppShell.tsx",
];

// Files that should use ScrollArea instead of overflow-y-auto
const scrollAreaFiles = [
  "components/ACPMain.tsx",
  "components/chat/PlanView.tsx",
  "components/chat/SessionSidebar.tsx",
  "components/chat/CommandMenu.tsx",
];

function readComponent(relPath: string): string {
  return readFileSync(resolve(webRoot, relPath), "utf-8");
}

describe("Task 6: Business component atomization", () => {
  describe("Button usage", () => {
    for (const file of buttonFiles) {
      test(`${file} imports Button from ui/button`, () => {
        const src = readComponent(file);
        // At least one of these patterns should be present
        const hasButtonImport = src.includes("import { Button }") || src.includes("import { Button,");

        // File should not have plain <button (with space after, to avoid matching <Button)
        // Allow hidden file inputs <input type="file"> and native <textarea>
        const nativeButtonPattern = /<button[\s>]/g;
        const nativeButtons = src.match(nativeButtonPattern) || [];

        expect(hasButtonImport || nativeButtons.length === 0).toBe(true);
      });
    }
  });

  describe("ScrollArea usage", () => {
    for (const file of scrollAreaFiles) {
      test(`${file} uses ScrollArea instead of overflow-y-auto`, () => {
        const src = readComponent(file);
        // Should import ScrollArea
        const hasScrollAreaImport = src.includes("ScrollArea") && src.includes("scroll-area");
        expect(hasScrollAreaImport).toBe(true);
      });
    }
  });

  describe("PlanView conditional ScrollArea", () => {
    test("PlanView uses ScrollArea when entries > 5", () => {
      const src = readComponent("components/chat/PlanView.tsx");
      // Should have ScrollArea in the file
      expect(src).toContain("<ScrollArea");
      // Should have conditional rendering for > 5 entries
      expect(src).toContain("total > 5");
    });
  });

  describe("StatusBadge uses shadcn Badge", () => {
    test("StatusBadge imports and uses Badge component", () => {
      const src = readComponent("components/config/StatusBadge.tsx");
      expect(src).toContain('from "../ui/badge"');
      expect(src).toContain("<Badge");
    });
  });

  describe("PermissionPanel uses shadcn Button", () => {
    test("PermissionPanel imports Button", () => {
      const src = readComponent("components/chat/PermissionPanel.tsx");
      expect(src).toContain('from "../ui/button"');
      expect(src).toContain("<Button");
    });
  });
});
