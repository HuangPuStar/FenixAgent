# 41. i18n 是 ViewModel 契约，不是上线前搜字符串

| 属性 | 结论 |
| --- | --- |
| 优先级 | P2 |
| 置信度 | 高 |
| 影响 | 语言切换不完整、日期/错误语义不一致、首屏加载全部语言资源 |

## 对抗判决

规范要求所有用户可见字符串使用 `t()`，多个核心页面仍硬编码中文/英文；通用日期组件固定 zh-CN。i18n 首屏静态加载两种语言全部 namespace，且 key 对称只靠人工。错误对象被不一致格式化后还会出现 `[object Object]`，语言层无法补救协议层漂移。

## 已核验证据

- `AgentKnowledgeBasesPage.tsx:545-615,790-816,1514-1604`、`ACPMain.tsx:430,451`、`SiteFrame.tsx:123,126`：用户字符串硬编码。
- `DataTable.tsx:381,384`、`HindsightToolCard.tsx:147-175`、`ChatHeader.tsx:165,183,320`、`AgentSitesPage.tsx:62-73`：相同问题。
- `web/components/ui/date-picker.tsx:17-32`：通用组件固定 `zh-CN`。
- `web/src/i18n/index.ts:4-51,82-172`：两种语言与 namespace 静态载入。
- en/zh key 已出现非对称项，虽当前未使用，说明缺少门禁。

## 架构诊断

页面直接拥有最终字符串和 locale implementation，ViewModel 没有稳定的 message key/参数 contract。通用组件不接 locale context，错误 response 又没有统一分类，导致 i18n locality 低。

## 目标不变量

- 所有用户可见文案、aria-label、toast、日期/数字/相对时间来自当前 locale。
- message key 两语言/必需 locale 对称，插值参数类型可检查；禁止单花括号等无效模板。
- route/feature namespace 按当前语言懒加载，并有 loading/fallback 规则。
- domain/API error 映射稳定 error code 到 message key；未知错误使用安全通用文案，不展示 raw message。
- 纯逻辑/后端不 import UI i18n/icon 依赖。

## 分阶段整改

1. 建 AST/ESLint 门禁阻止 JSX/toast/aria 新增硬编码，生成现存 baseline。
2. 清核心 Chat/Knowledge/Workflow/Agent flows，补 locale 行为测试。
3. 通用日期/数字组件接 locale context；namespace 懒加载。
4. CI 检查 key 对称、未使用/缺失 key 和插值占位符。

## 验收

- 运行中切换语言，关键流程与 screen reader 名称同步更新，无刷新依赖。
- 日期、数字、错误和空状态符合 locale；缺 key 在 CI 失败而非生产显示 key。
- 初始 i18n payload 只包含当前 locale/route 所需 namespace。
