(() => {
  /** Serialized into the editor sandbox; it cannot capture plugin-window variables. */
  function readSpreadsheetSelection() {
    try {
      const range = Api.GetSelection();
      if (!range) return null;
      const count = range.GetCellsCount();
      const rows = range.GetRowsCount();
      if (!Number.isFinite(count) || !Number.isFinite(rows) || count < 1 || rows < 1 || count > 1024)
        return JSON.stringify({ error: "tooLarge" });
      const columns = count / rows;
      if (!Number.isInteger(columns)) return JSON.stringify({ error: "tooLarge" });
      const lines = [];
      let size = 0;
      for (let row = 1; row <= rows; row++) {
        const cells = [];
        for (let column = 1; column <= columns; column++) {
          const text = String(range.GetCells(row, column).GetText() ?? "");
          size += text.length + 1;
          if (size > 65536) return JSON.stringify({ error: "tooLarge" });
          cells.push(text);
        }
        lines.push(cells.join("\t"));
      }
      const address = range.GetAddress(false, false, "xlA1", false);
      if (!address || address.includes(",")) return JSON.stringify({ error: "tooLarge" });
      return JSON.stringify({ text: lines.join("\n"), location: `${range.GetWorksheet().GetName()}!${address}` });
    } catch (error) {
      console.error(
        "[file-selection] Spreadsheet selection read failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return JSON.stringify({ error: "unavailable" });
    }
  }

  window.FenixOfficeSelection = { readSpreadsheetSelection };
})();
