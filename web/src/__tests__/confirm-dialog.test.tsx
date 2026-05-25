import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import ReactDOMServer from "react-dom/server";
import { ConfirmDialog } from "../../components/config/ConfirmDialog";

describe("ConfirmDialog", () => {
  test("exports ConfirmDialog as a function", () => {
    expect(typeof ConfirmDialog).toBe("function");
  });

  test("renders without throwing with minimal props", () => {
    expect(() => {
      ReactDOMServer.renderToString(
        <ConfirmDialog
          open={true}
          onOpenChange={() => {}}
          title="测试标题"
          description="测试描述"
          onConfirm={() => {}}
        />,
      );
    }).not.toThrow();
  });

  test("renders with all props without throwing", () => {
    expect(() => {
      ReactDOMServer.renderToString(
        <ConfirmDialog
          open={true}
          onOpenChange={() => {}}
          title="删除确认"
          description="确定要删除吗？"
          confirmLabel="删除"
          cancelLabel="返回"
          variant="destructive"
          onConfirm={() => {}}
          loading={true}
        />,
      );
    }).not.toThrow();
  });

  test("ConfirmDialog uses AlertDialog internally (import check)", async () => {
    const alertDialogMod = await import("../../components/ui/alert-dialog");
    expect(typeof alertDialogMod.AlertDialog).toBe("function");
    expect(typeof alertDialogMod.AlertDialogContent).toBe("function");
    expect(typeof alertDialogMod.AlertDialogAction).toBe("function");
    expect(typeof alertDialogMod.AlertDialogCancel).toBe("function");
  });

  test("ConfirmDialog.tsx imports from ui/alert-dialog", () => {
    const content = fs.readFileSync(
      join(import.meta.dirname, "..", "..", "components/config/ConfirmDialog.tsx"),
      "utf-8",
    );
    // import.meta.dirname = web/src/__tests__, so ../../components = web/components
    expect(content).toContain('from "../ui/alert-dialog"');
    expect(content).not.toMatch(/from.*ui\/dialog/);
  });
});
