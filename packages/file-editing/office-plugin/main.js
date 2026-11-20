(() => {
  const plugin = window.Asc.plugin;
  const type = "fenix-office-selection";
  const actionId = "fenix-quote-selection";
  let channel;
  let targetOrigin;
  let captured;
  let generation = 0;
  let finishPending;
  let currentSlide;
  const chinese = () => (plugin.info.lang ?? "").startsWith("zh");
  const post = (data) => {
    if (channel && targetOrigin) window.top.postMessage({ type, channel, ...data }, targetOrigin);
  };
  plugin.init = () => {
    plugin.attachEditorEvent("onContextMenuShow", onContextMenuShow);
    plugin.attachEditorEvent("onContextMenuClick", onContextMenuClick);
    if (plugin.info.editorType === "slide") {
      // Even read-only macros mark presentations dirty; cursor events do not create history.
      plugin.attachEditorEvent("onChangeCurrentSlide", (index) => {
        currentSlide = Number.isInteger(index) && index >= 0 ? index + 1 : undefined;
      });
    }
    // Bootstrap carries no document content; only the bound host receives later snapshots.
    window.top.postMessage({ type, action: "ready", guid: plugin.guid }, "*");
  };
  plugin.button = () => {};
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      event.source !== window.top ||
      !/^https?:\/\//.test(event.origin) ||
      !data ||
      data.type !== type ||
      data.action !== "bind" ||
      typeof data.channel !== "string"
    )
      return;
    channel = data.channel;
    targetOrigin = event.origin;
  });
  const onContextMenuShow = () => {
    finishPending?.();
    const current = ++generation;
    const slide = currentSlide;
    captured = null;
    let answered = false;
    let timer;
    const answer = (value) => {
      if (answered || current !== generation) return;
      answered = true;
      clearTimeout(timer);
      captured = value;
      plugin.executeMethod("AddContextMenuItem", [
        {
          guid: plugin.guid,
          items: value ? [{ id: actionId, text: chinese() ? "添加到对话…" : "Add to conversation…" }] : [],
        },
      ]);
    };
    finishPending = () => answer(null);
    timer = setTimeout(() => answer(null), 500);
    if (!channel) {
      answer(null);
      return;
    }
    plugin.executeMethod("GetSelectionType", [], (selectionType) => {
      if (selectionType === "drawing") {
        answer(null);
        return;
      }
      const readCells = () => {
        plugin.callCommand(window.FenixOfficeSelection.readSpreadsheetSelection, false, false, (encoded) => {
          if (typeof encoded !== "string") {
            answer(null);
            return;
          }
          try {
            const value = JSON.parse(encoded);
            answer(value?.error || value?.text?.trim() ? value : null);
          } catch (error) {
            console.error(
              "[file-selection] Invalid command result",
              error instanceof Error ? error.name : "UnknownError",
            );
            answer(null);
          }
        });
      };
      // Presentations report "slide" even when text is selected inside a shape.
      if (selectionType !== "text" && plugin.info.editorType !== "slide") {
        if (plugin.info.editorType === "cell") readCells();
        else answer(null);
        return;
      }
      plugin.executeMethod(
        "GetSelectedText",
        [
          {
            Numbering: true,
            Math: true,
            TableCellSeparator: "\t",
            TableRowSeparator: "\n",
            ParaSeparator: "\n",
            TabSymbol: "\t",
            NewLineSeparator: "\n",
          },
        ],
        (text) => {
          if (typeof text !== "string" || !text.trim()) {
            // Cells also report "text"; only an in-cell text selection has selected text.
            if (plugin.info.editorType === "cell") readCells();
            else answer(null);
            return;
          }
          if (text.length > 65536) {
            answer({ error: "tooLarge" });
            return;
          }
          if (plugin.info.editorType === "slide") {
            answer({ text, ...(slide ? { location: chinese() ? `第 ${slide} 张幻灯片` : `Slide ${slide}` } : {}) });
          } else answer({ text });
        },
      );
    });
  };
  const onContextMenuClick = (id) => {
    if (id !== actionId) return;
    const snapshot = captured;
    captured = null;
    if (!snapshot) return;
    if (snapshot.error) post({ action: "error", code: snapshot.error });
    else
      post({ action: "selection", text: snapshot.text, ...(snapshot.location ? { location: snapshot.location } : {}) });
  };
})();
