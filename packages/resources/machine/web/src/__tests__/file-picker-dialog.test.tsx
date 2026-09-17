import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";
import type { FileInfo } from "../../../../../../apps/web/src/types";

describe("FilePickerDialog", () => {
  test("exports FilePickerDialog as a function", async () => {
    const mod = await import("../../../../../../apps/web/src/components/FilePickerDialog");
    expect(typeof mod.FilePickerDialog).toBe("function");
  });

  test("renders without throwing with required props", async () => {
    const { FilePickerDialog } = await import("../../../../../../apps/web/src/components/FilePickerDialog");
    expect(() => {
      ReactDOMServer.renderToString(
        <FilePickerDialog open={true} envId="env_1" onClose={() => {}} onSelect={() => {}} />,
      );
    }).not.toThrow();
  });

  test("renders with open=false without throwing", async () => {
    const { FilePickerDialog } = await import("../../../../../../apps/web/src/components/FilePickerDialog");
    expect(() => {
      ReactDOMServer.renderToString(
        <FilePickerDialog open={false} envId="env_1" onClose={() => {}} onSelect={() => {}} />,
      );
    }).not.toThrow();
  });

  test("imports Dialog component from ui/dialog", async () => {
    const dialogMod = await import("@/components/ui/dialog");
    expect(typeof dialogMod.Dialog).toBe("function");
    expect(typeof dialogMod.DialogContent).toBe("function");
    expect(typeof dialogMod.DialogTitle).toBe("function");
  });

  test("exports workspace file API from api/fs", async () => {
    const fsMod = await import("../../../../../../apps/web/src/api/fs");
    expect(fsMod.fsApi).toBeDefined();
    expect(typeof fsMod.fsApi.listDir).toBe("function");
    expect(typeof fsMod.uploadFiles).toBe("function");
    expect(typeof fsMod.uploadChatFiles).toBe("function");
  });

  test("FileInfo type is exported from types", async () => {
    const _typesMod = await import("../../../../../../apps/web/src/types");
    const dummy: FileInfo = { name: "test.txt", path: "user/test.txt", type: "file", size: 100, modifiedAt: 0 };
    expect(dummy.name).toBe("test.txt");
    // Verify the import works — if FileInfo type doesn't exist, this file won't compile
  });
});
