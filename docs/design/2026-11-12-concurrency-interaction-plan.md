# 并发管理交互实现

目标：落实已确认的并发管理交互预览，保留系统密钥认证和现有准入语义。

1. 平台限制默认只读，按行修改并仅 PATCH 对应维度；展示默认/自定义，恢复前确认当前值与默认值。
2. 用户配置在弹窗编辑，使用身份目录的有界搜索，候选只投影 ID、姓名、邮箱；用户恢复后跟随平台默认。
3. 沿用 UI 组件、ahooks、request/unwrap 与中英字典。提交后先应用写响应，刷新失败仍保留已提交结果；编辑草稿不被刷新覆盖。
4. 先补页面交互和系统搜索授权回归，再实现。验证相关 bun test、fastcheck、build:web、precheck。无 schema 变化，不创建 commit。

文件：agent-runtime 的并发页面、用户配置弹窗、API client、字典；现有并发 facade/routes/schema；并发页面与系统 API 测试。
