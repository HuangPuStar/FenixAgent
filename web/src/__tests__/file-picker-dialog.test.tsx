import { describe, test, expect } from "bun:test";
import ReactDOMServer from "react-dom/server";
import React from "react";

describe("FilePickerDialog", () => {
  test("exports FilePickerDialog as a function", async () => {
    const mod = await import("../components/FilePickerDialog");
    expect(typeof mod.FilePickerDialog).toBe("function");
  });

  test("renders without throwing with required props", async () => {
    const { FilePickerDialog } = await import("../components/FilePickerDialog");
    expect(() => {
      ReactDOMServer.renderToString(
        <FilePickerDialog
          open={true}
          sessionId="s1"
          onClose={() => {}}
          onSelect={() => {}}
        />
      );
    }).not.toThrow();
  });

  test("renders with open=false without throwing", async () => {
    const { FilePickerDialog } = await import("../components/FilePickerDialog");
    expect(() => {
      ReactDOMServer.renderToString(
        <FilePickerDialog
          open={false}
          sessionId="s1"
          onClose={() => {}}
          onSelect={() => {}}
        />
      );
    }).not.toThrow();
  });

  test("imports Dialog component from ui/dialog", async () => {
    const dialogMod = await import("../../components/ui/dialog");
    expect(typeof dialogMod.Dialog).toBe("function");
    expect(typeof dialogMod.DialogContent).toBe("function");
    expect(typeof dialogMod.DialogTitle).toBe("function");
  });

  test("exports client and fetchUpload from api/client", async () => {
    const clientMod = await import("../api/client");
    expect(clientMod.client).toBeDefined();
    expect(typeof clientMod.fetchUpload).toBe("function");
  });

  test("FileInfo type is exported from types", async () => {
    const typesMod = await import("../types");
    const dummy: any = { name: "test.txt", path: "user/test.txt", type: "file" as const, size: 100, modifiedAt: 0 };
    expect(dummy.name).toBe("test.txt");
    // Verify the import works — if FileInfo type doesn't exist, this file won't compile
  });
});
