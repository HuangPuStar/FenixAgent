import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

// 提供方的静态文件长期缓存，入口版本必须传到两个脚本并保持加载顺序。
test("propagates the plugin release version to its ordered scripts", async () => {
  const config = JSON.parse(await readFile(new URL("../../office-plugin/config.json", import.meta.url), "utf8"));
  const page = new URL(config.variations[0].url, "https://office.example/plugin/");
  expect(page.searchParams.get("v")).toBe(config.version);
  const html = await readFile(new URL("../../office-plugin/index.html", import.meta.url), "utf8");
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!inline) throw Error("Versioned plugin loader missing");
  const scripts: Array<{ src: string; async: boolean }> = [];
  runInContext(
    inline,
    createContext({
      URL,
      location: { href: page.href },
      document: {
        createElement: () => ({ src: "", async: true }),
        head: { append: (script: { src: string; async: boolean }) => scripts.push(script) },
      },
    }),
  );
  expect(scripts).toEqual([
    { src: `selection.js?v=${config.version}`, async: false },
    { src: `main.js?v=${config.version}`, async: false },
  ]);
});

async function pluginFixture(editorType = "word", api: Record<string, unknown> = {}) {
  const menu: Array<{ items: Array<{ id: string }> }> = [];
  const messages: Array<Record<string, unknown>> = [];
  const editorEvents = new Map<string, (options: unknown) => void>();
  const pendingReads: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let receiver: ((event: { source: unknown; origin: string; data: unknown }) => void) | undefined;
  const top = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
  const selection = {
    text: editorType === "cell" ? "" : "  original\n    code",
    type: editorType === "slide" ? "slide" : "text",
    pause: false,
  };
  const plugin = {
    guid: "asc.test-quote-plugin",
    info: { editorType, lang: "en" },
    init: () => {},
    button: () => {},
    event_onContextMenuShow: (_options: unknown) => {},
    attachEditorEvent: (id: string, callback: (options: unknown) => void) => editorEvents.set(id, callback),
    // SDK 的本地点击助手不会替编辑器订阅原生事件。
    attachContextMenuClickEvent: (_id: string, _callback: () => void) => {},
    executeMethod: (method: string, args: unknown[], callback?: (value: unknown) => void) => {
      if (method === "AddContextMenuItem") menu.push(args[0] as { items: Array<{ id: string }> });
      if (method === "GetSelectedText") {
        const snapshot = selection.text;
        if (selection.pause) pendingReads.push(() => callback?.(snapshot));
        else callback?.(snapshot);
      }
      if (method === "GetSelectionType") callback?.(selection.type);
      return true;
    },
    callCommand: (command: () => unknown, _close: boolean, _calculate: boolean, callback: (value: unknown) => void) => {
      if (editorType === "slide") throw Error("Read macros can mark presentations dirty");
      const result = command();
      callback(result !== null && typeof result === "object" ? undefined : result);
    },
  };
  const context = createContext({
    window: {
      Asc: { plugin },
      top,
      addEventListener: (_name: string, callback: typeof receiver) => {
        receiver = callback;
      },
    },
    Api: api,
    setTimeout: (callback: () => void) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    console,
  });
  for (const file of ["selection.js", "main.js"])
    runInContext(await readFile(new URL(`../../office-plugin/${file}`, import.meta.url), "utf8"), context);
  plugin.init();
  receiver?.({
    source: top,
    origin: "https://app.example",
    data: { type: "fenix-office-selection", action: "bind", channel: "test-channel" },
  });
  return {
    plugin,
    menu,
    messages,
    slideChanged: (index: number) => editorEvents.get("onChangeCurrentSlide")?.(index),
    click: (id: string) => editorEvents.get("onContextMenuClick")?.(id),
    selection,
    pendingReads,
    expire: () => {
      for (const callback of [...timers.values()]) callback();
    },
    show: (options: unknown) => editorEvents.get("onContextMenuShow")?.(options),
  };
}

// 右键菜单追加项目必须读取当时的选区，点击后不重新取已经变化的文本。
test("extends the native menu and quotes its captured text", async () => {
  const fixture = await pluginFixture();
  fixture.show({ type: "Selection" });
  expect(fixture.menu.at(-1)?.items).toHaveLength(1);
  fixture.selection.text = "changed";
  fixture.click(fixture.menu.at(-1)?.items[0]?.id ?? "");
  expect(fixture.messages.at(-1)).toMatchObject({
    action: "selection",
    text: "  original\n    code",
    channel: "test-channel",
  });
});

// 读取整列前就拒绝，不遍历或计算全部单元格文本，原菜单仍得到响应。
test("rejects huge spreadsheet selections before reading cells", async () => {
  const fixture = await pluginFixture("cell", {
    GetSelection: () => ({
      GetCellsCount: () => 1048576,
      GetRowsCount: () => 1048576,
      GetCells: () => {
        throw new Error("must not read cells");
      },
    }),
  });
  fixture.show({ type: "Target" });
  fixture.click(fixture.menu.at(-1)?.items[0]?.id ?? "");
  expect(fixture.messages.at(-1)).toMatchObject({ action: "error", code: "tooLarge" });
});

// Excel 引用包含显示值和实际范围，不能把单元格格式值改成原始公式。
test("reads spreadsheet display values with row and cell separators", async () => {
  const fixture = await pluginFixture("cell", {
    GetSelection: () => ({
      GetCellsCount: () => 4,
      GetRowsCount: () => 2,
      GetCells: (row: number, col: number) => ({
        GetText: () =>
          [
            ["¥1,200", "42"],
            ["", "合计"],
          ][row - 1]?.[col - 1],
      }),
      GetAddress: () => "B2:C3",
      GetWorksheet: () => ({ GetName: () => "Sheet1" }),
    }),
  });
  fixture.show({ type: "Target" });
  fixture.click(fixture.menu.at(-1)?.items[0]?.id ?? "");
  expect(fixture.messages.at(-1)).toMatchObject({
    action: "selection",
    text: "¥1,200\t42\n\t合计",
    location: "Sheet1!B2:C3",
  });
});

// 单元格内选了一部分文字时应保留局部文字，不扩大成整格内容。
test("prefers selected in-cell text over the full cell range", async () => {
  const fixture = await pluginFixture("cell", {
    GetSelection: () => {
      throw Error("must not expand text selection");
    },
  });
  fixture.selection.text = "selected fragment";
  fixture.show({ type: "Selection" });
  fixture.click(fixture.menu.at(-1)?.items[0]?.id ?? "");
  expect(fixture.messages.at(-1)).toMatchObject({ action: "selection", text: "selected fragment" });
});

// 无文字对象不能生成误导引用，但必须完成菜单事件响应。
test("returns an empty extension for drawing selections", async () => {
  const fixture = await pluginFixture();
  fixture.selection.type = "drawing";
  fixture.show({ type: "Image" });
  expect(fixture.menu.at(-1)?.items).toEqual([]);
});

// 重叠菜单必须结束旧轮，迟到读取不能卡住原菜单或覆盖新快照。
test("answers the previous menu once before reading a newer selection", async () => {
  const fixture = await pluginFixture();
  fixture.selection.pause = true;
  fixture.show({ type: "Selection" });
  fixture.selection.text = "second selection";
  fixture.show({ type: "Selection" });
  expect(fixture.menu).toHaveLength(1);
  expect(fixture.menu[0]?.items).toEqual([]);
  fixture.pendingReads[0]?.();
  fixture.pendingReads[1]?.();
  expect(fixture.menu).toHaveLength(2);
  fixture.click(fixture.menu[1]?.items[0]?.id ?? "");
  expect(fixture.messages.at(-1)).toMatchObject({ action: "selection", text: "second selection" });
});

// 提供方未回调时必须归还原菜单，迟到结果不能再次回答或生成旧引用。
test("finishes a timed-out menu and ignores its late selection", async () => {
  const fixture = await pluginFixture();
  fixture.selection.pause = true;
  fixture.show({ type: "Selection" });
  fixture.expire();
  expect(fixture.menu).toEqual([{ guid: "asc.test-quote-plugin", items: [] }]);
  fixture.pendingReads[0]?.();
  expect(fixture.menu).toHaveLength(1);
});

// 幻灯片只带当前位置和选中文字，不需要枚举整份演示文稿。
test("quotes slide text with its one-based slide position", async () => {
  const fixture = await pluginFixture("slide");
  fixture.slideChanged(2);
  fixture.show({ type: "Selection" });
  fixture.click(fixture.menu.at(-1)?.items[0]?.id ?? "");
  expect(fixture.messages.at(-1)).toMatchObject({
    action: "selection",
    text: "  original\n    code",
    location: "Slide 3",
  });
});

// 首次收到页码事件之前只引用文字，不能运行宏猜测位置并污染文档历史。
test("quotes presentation text without macros before the first slide event", async () => {
  const fixture = await pluginFixture("slide");
  fixture.show({ type: "Selection" });
  fixture.click(fixture.menu.at(-1)?.items[0]?.id ?? "");
  expect(fixture.messages.at(-1)).toMatchObject({ action: "selection", text: "  original\n    code" });
  expect(fixture.messages.at(-1)?.location).toBeUndefined();
});

// 异步读取时页码变化不能把旧选中文字标成新页码。
test("captures slide position when opening the context menu", async () => {
  const fixture = await pluginFixture("slide");
  fixture.slideChanged(2);
  fixture.selection.pause = true;
  fixture.show({ type: "Selection" });
  fixture.slideChanged(3);
  fixture.pendingReads[0]?.();
  fixture.click(fixture.menu.at(-1)?.items[0]?.id ?? "");
  expect(fixture.messages.at(-1)).toMatchObject({ location: "Slide 3" });
});

// 幻灯片类型本身不代表选中了文字，空文本不能占用对话引用。
test("keeps the native menu when a slide has no selected text", async () => {
  const fixture = await pluginFixture("slide");
  fixture.selection.text = "";
  fixture.show({ type: "Slide" });
  expect(fixture.menu.at(-1)?.items).toEqual([]);
});
