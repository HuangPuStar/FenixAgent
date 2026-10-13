import { describe, expect, test } from "bun:test";
import { repairUnclosedUISpecFence } from "../chat/ui-spec/fence-repair";

const spec =
  '{\n  "version": 1,\n  "root": "note",\n  "elements": {\n    "note": { "type": "Text", "props": { "text": "好" } }\n  }\n}';
const open = "```ui-spec";

describe("ui-spec 未闭合围栏补全", () => {
  // 真实事故形态：围栏未闭合 + JSON 后跟大段正文；补全后 JSON 回围栏内、正文回围栏外
  test("未闭合围栏 + 平衡 JSON + 尾随正文", () => {
    const markdown = `${open}\n${spec}\n\n后续说明文字`;
    const repaired = repairUnclosedUISpecFence(markdown);
    // 只在 JSON 结束处插入闭合标记（原文行尾换行保留），其余字符逐字不动
    expect(repaired).toBe(`${open}\n${spec}\n\`\`\`\n\n\n后续说明文字`);
    expect(repaired.endsWith("后续说明文字")).toBe(true);
  });

  // 已闭合的围栏必须一字不动，否则会凭空多出一个空代码块
  test("已闭合围栏原样返回", () => {
    const markdown = `${open}\n${spec}\n\`\`\`\n尾随`;
    expect(repairUnclosedUISpecFence(markdown)).toBe(markdown);
  });

  // 半截 JSON 无法定位结束位置：不补括号、不猜内容，保持既有降级
  test("半截 JSON 原样返回", () => {
    const markdown = `${open}\n{"version":1,"root":`;
    expect(repairUnclosedUISpecFence(markdown)).toBe(markdown);
  });

  // 其他语言的未闭合围栏不属于本模块职责
  test("非 ui-spec 围栏原样返回", () => {
    const markdown = '```json\n{"a":1}\n尾随';
    expect(repairUnclosedUISpecFence(markdown)).toBe(markdown);
  });

  // 语言比对大小写敏感，与 UI_SPEC_PLUGINS 的识别口径一致
  test("大小写不一致不补全", () => {
    const markdown = '```UI-SPEC\n{"version":1}\n尾随';
    expect(repairUnclosedUISpecFence(markdown)).toBe(markdown);
  });

  // info string 取首词，多词写法仍识别（与 streamdown 的语言提取一致）
  test("info 多词取首词", () => {
    const markdown = '```ui-spec json\n{"version":1}\n尾随';
    expect(repairUnclosedUISpecFence(markdown)).toBe('```ui-spec json\n{"version":1}\n```\n\n尾随');
  });

  // 行内代码里的 `ui-spec` 不是围栏标记，正文不得被误判
  test("行内代码不误判", () => {
    const markdown = '写成 `ui-spec` 才能渲染\n\n{ "version": 1 }';
    expect(repairUnclosedUISpecFence(markdown)).toBe(markdown);
  });

  // 字符串值内的花括号不参与配平，结束位置必须落在真正的对象尾部
  test("JSON 字符串内的花括号不影响结束定位", () => {
    const markdown = '```ui-spec\n{"text":"a}b{c"}\n尾随';
    expect(repairUnclosedUISpecFence(markdown)).toBe('```ui-spec\n{"text":"a}b{c"}\n```\n\n尾随');
  });

  // 折行文本会让字符串字面量内出现裸换行，配对扫描不受其影响
  test("JSON 字符串内裸换行仍能定位结束", () => {
    const markdown = '```ui-spec\n{"text":"foo\ntnote"}\n尾随';
    expect(repairUnclosedUISpecFence(markdown)).toBe('```ui-spec\n{"text":"foo\ntnote"}\n```\n\n尾随');
  });

  // 前一个围栏已闭合、后一个未闭合：只补后一个
  test("只处理最后一个未闭合的 ui-spec 围栏", () => {
    const markdown = '```ui-spec\n{"a":1}\n```\n中间\n```ui-spec\n{"b":2}\n尾随';
    expect(repairUnclosedUISpecFence(markdown)).toBe(
      '```ui-spec\n{"a":1}\n```\n中间\n```ui-spec\n{"b":2}\n```\n\n尾随',
    );
  });

  // 四空格缩进是缩进代码块的字面文本，不是围栏（CommonMark 允许的最大缩进为三空格）
  test("四空格缩进的标记不识别", () => {
    const markdown = '    ```ui-spec\n{"a":1}\n尾随';
    expect(repairUnclosedUISpecFence(markdown)).toBe(markdown);
  });

  // 围栏内容不是对象（数组/标量）时不补全，交给既有降级矩阵
  test("内容非对象则不补全", () => {
    const markdown = "```ui-spec\n[1,2,3]\n尾随";
    expect(repairUnclosedUISpecFence(markdown)).toBe(markdown);
  });

  // 无围栏的普通文本快速路径原样返回
  test("无围栏原样返回", () => {
    const markdown = "# 标题\n\n正文段落，含 `行内代码`。";
    expect(repairUnclosedUISpecFence(markdown)).toBe(markdown);
  });

  // CRLF 行尾（Windows 来源文本）同样能补全，且不吞掉正文
  test("CRLF 行尾正常补全", () => {
    const markdown = '```ui-spec\r\n{"a":1}\r\n尾随';
    const repaired = repairUnclosedUISpecFence(markdown);
    expect(repaired).toContain("\n```\n");
    expect(repaired.endsWith("尾随")).toBe(true);
    expect(repaired.replace("\n```\n", "")).toBe(markdown);
  });
});
