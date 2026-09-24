// Provider 弹窗模型选择列表的候选集合并（`agent-models-utils.mergeModelCandidates`）。
//
// 这条规则存在的原因与它守护的缺陷同源：手动输入的模型 ID 不在服务商的列表接口里——部分服务商的列表
// 接口与消息接口不在同一个地址上（Anthropic 兼容端点常只实现 `/v1/messages`），列表探测必然 404，模型
// 本身却可用。若列表只渲染探测结果，探测失败清空列表后手动条目会从界面上消失、但仍留在待提交的
// `selectedModels` 里，用户既看不到也取消不掉，只能在保存后去模型行里删除。
//
// 渲染层（弹窗本身）由类型检查与 i18n 键用例共同守护，这里只钉住"什么会出现在列表里"这条规则。

import { describe, expect, test } from "bun:test";
import { mergeModelCandidates } from "../pages/agent-panel/pages/agent-models-utils";

describe("mergeModelCandidates", () => {
  // 探测结果在前、手动条目在后：用户刚输入的那一项紧跟在探测结果尾部，位置可预期。
  test("探测结果在前，未出现在探测结果里的已选条目追加在后", () => {
    expect(mergeModelCandidates(["deepseek-v4-flash", "deepseek-v4-pro"], ["my-custom-model"])).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "my-custom-model",
    ]);
  });

  // 已选条目同时出现在探测结果里时只能占一个位置，否则列表会出现两张同名卡片、选中态互相矛盾。
  test("重复项按一次出现", () => {
    expect(mergeModelCandidates(["deepseek-v4-flash"], ["deepseek-v4-flash"])).toEqual(["deepseek-v4-flash"]);
  });

  // 探测失败清空探测结果后，手动条目仍必须留在候选集里（这正是幽灵选择缺陷的回归断言）。
  test("探测结果为空时保留已选手动条目", () => {
    expect(mergeModelCandidates([], ["deepseek-v4-pro"])).toEqual(["deepseek-v4-pro"]);
  });

  // 未选中任何模型且探测无结果时列表为空：弹窗据此不渲染空列表容器。
  test("两侧都为空时返回空数组", () => {
    expect(mergeModelCandidates([], [])).toEqual([]);
  });
});
