import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import ReactDOMServer from "react-dom/server";

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
    const alertDialogMod = await import("@fenix/ui-components/ui/alert-dialog");
    expect(typeof alertDialogMod.AlertDialog).toBe("function");
    expect(typeof alertDialogMod.AlertDialogContent).toBe("function");
    expect(typeof alertDialogMod.AlertDialogAction).toBe("function");
    expect(typeof alertDialogMod.AlertDialogCancel).toBe("function");
  });

  test("ConfirmDialog 内部用 AlertDialog 而非普通 Dialog", () => {
    // 实现文件的 owner 已归 `@fenix/ui-components`（§1.6 T8b 删除宿主副本），断言随之指向包内文件；
    // 被守护的意图不变：确认弹窗必须走 AlertDialog 语义（否则读屏/ESC 行为与确认语义都不对）。
    // 用例随实现迁入包内（§1.6 T10b1）后，该路径从「四级相对回包」变成同包内的一跳。
    const content = fs.readFileSync(join(import.meta.dirname, "..", "config/ConfirmDialog.tsx"), "utf-8");
    expect(content).toContain('from "../ui/alert-dialog"');
    expect(content).not.toMatch(/from.*ui\/dialog/);
  });
});
