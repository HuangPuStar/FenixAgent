// 文件选择面板的**消费方契约**（W2.5 重写）。
//
// 归属：面板本体与会话附件视图类型按 §6.5 的共享 web 模块裁决上收到 `@fenix/ui-components`，本包经对方
// **包根入口**取用（`web/chat/shell/FilePickerPanel` 这类深路径不在其 exports 里，写死会把对方的内部目录
// 变成事实契约）。宿主侧只剩把它包进 Dialog、补 `envId` 的会话入口（`apps/web/src/components/FilePickerDialog.tsx`）
// 与 `apps/web/src/api/fs` 网络层，两者归 §1.6 随 WebShell 迁移，本包不拥有。
//
// 为什么要重写：旧版本用六级相对路径的运行时 `await import()` 加载宿主组件与宿主 `api/fs` 网络层，
// 在宿主解析环境之外无法构建（§1 静态条件 3），而且断言只是「宿主文件存在且导出是函数」，不覆盖面板
// 行为本身。现在改为对本包真实消费的公开入口做渲染与类型契约断言。
//
// SSR 覆盖边界：`renderToString` 不执行 effect，面板 mount 时的目录加载不跑，因此这里断言的是首屏结构
// （搜索 / 上传 / 空态）与注入契约；目录切换、竞态丢弃、上传体积校验等交互级断言需要 DOM 环境，
// 属面板 owner `@fenix/ui-components` 的测试职责（见报告「遗留」）。
//
// i18n 说明：资源包自带 i18n 单例会被宿主注册流程覆盖，本包 web 测试不初始化 i18next，`t()` 回退为
// key 本身；这里的断言因此锚在**键名**上（面板向宿主请求哪条文案），文案内容由 owner 包的
// `web/i18n/locales/*/uiComponents.json` 保证。
import { describe, expect, test } from "bun:test";
import type { FileInfo, FilePickerPanelProps } from "@fenix/ui-components";
import { FilePickerPanel } from "@fenix/ui-components";
import ReactDOMServer from "react-dom/server";

/** 面板契约的最小注入：目录列表与上传均由调用方提供，面板自身不碰网络层。 */
function pickerProps(overrides: Partial<FilePickerPanelProps> = {}): FilePickerPanelProps {
  return {
    listDir: async () => ({ entries: [] }),
    uploadFiles: async () => ({ files: [] }),
    onSelect: () => {},
    onClose: () => {},
    ...overrides,
  };
}

/** 渲染面板首屏；仅断言结构，不做交互模拟。 */
function renderPicker(overrides: Partial<FilePickerPanelProps> = {}): string {
  return ReactDOMServer.renderToString(<FilePickerPanel {...pickerProps(overrides)} />);
}

describe("文件选择面板（消费方契约）", () => {
  // 面板必须以具名函数导出，宿主会话入口才能按名取用并包装成对话框。
  test("以具名函数导出", () => {
    expect(typeof FilePickerPanel).toBe("function");
  });

  // 首屏必须同时给出搜索、上传与空态三个可操作面，且渲染期不依赖浏览器专有 API（可在 SSR 下渲染）。
  test("首屏渲染搜索、上传与空态", () => {
    const html = renderPicker();

    expect(html).toContain("chat.components.filePicker.searchPlaceholder");
    expect(html).toContain("chat.components.filePicker.uploadFile");
    expect(html).toContain("chat.components.filePicker.noFiles");
    expect(html).toContain('type="file"');
  });

  // 列目录与上传回调的签名是面板与调用方之间的真实契约：参数或返回形状缩水会让调用方静默失去能力。
  // 断言主体是编译期（`FilePickerPanelProps` 不接受缺项 / 错型），运行期确认该契约可被面板消费，
  // 并把调用方必须产出的响应形状（`entries: FileInfo[]` / `files`）钉在这里——宿主 `api/fs` 迁移时照此对齐。
  test("注入契约保留列目录、上传与选中回调", async () => {
    const props = pickerProps({
      listDir: async (dirPath) => ({
        entries: [
          { name: "brief.md", path: `user/${dirPath}brief.md`, type: "file" as const, size: 12, modifiedAt: 0 },
        ],
      }),
      uploadFiles: async (files) => ({ files: files.map((file) => ({ name: file.name, path: "", size: 0 })) }),
    });

    const list = await props.listDir("");
    const upload = await props.uploadFiles([new File([], "brief.md")]);

    expect(list.entries[0].path).toBe("user/brief.md");
    expect(upload.files.map((file) => file.name)).toEqual(["brief.md"]);
    expect(ReactDOMServer.renderToString(<FilePickerPanel {...props} />)).toContain("chat.components.filePicker");
  });

  // 选中项以 `FileInfo` 形状回传：路径是 workspace 相对路径（服务端按该口径校验），相对路径不得带前导斜杠。
  test("选中项使用 workspace 相对路径的 FileInfo 形状", () => {
    const entry: FileInfo = { name: "brief.md", path: "user/brief.md", type: "file", size: 12, modifiedAt: 0 };

    expect(entry.type).toBe("file");
    expect(entry.path.startsWith("/")).toBe(false);
  });

  // 对话框原语（Dialog / DialogContent / DialogTitle）只在共享 UI 包内声明：宿主会话入口要把面板包成对话框，
  // 这些名字一旦从共享包消失，宿主与本包都会在解析期失败。
  test("共享 UI 包提供 Dialog 原语", async () => {
    const dialogMod = await import("@fenix/ui-components/ui/dialog");

    expect(typeof dialogMod.Dialog).toBe("function");
    expect(typeof dialogMod.DialogContent).toBe("function");
    expect(typeof dialogMod.DialogTitle).toBe("function");
  });
});
