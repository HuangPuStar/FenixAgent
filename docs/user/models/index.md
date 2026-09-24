# 大模型配置

## 页面入口

登录 FenixAgent 控制面板后，点击左侧导航栏的 **大模型配置**。

页面是一个可展开列表，每个服务商可以展开查看其下的模型。

## 新建服务商

点击右上角 **新建服务商** 按钮，填写表单：

| 字段 | 说明 | 示例 |
|------|------|------|
| ID | 唯一标识符，创建后不可改 | `openai` |
| 显示名称 | 界面显示的名称 | `OpenAI` |
| 协议 | 消息调用的接口方言 | OpenAI 兼容 / Anthropic |
| API Key | 服务商密钥 | `sk-xxxx...` |
| Base URL | API 地址（可选） | `https://api.openai.com/v1` |

**常用服务商配置**：

| 服务商 | 协议 | Base URL |
|--------|------|----------|
| OpenAI | OpenAI 兼容 | `https://api.openai.com/v1` |
| Anthropic (Claude) | Anthropic | `https://api.anthropic.com/v1` |
| 阿里云百炼 | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| DeepSeek（OpenAI 兼容） | OpenAI 兼容 | `https://api.deepseek.com` |
| DeepSeek（Anthropic 兼容） | Anthropic | `https://api.deepseek.com/anthropic` |

Base URL 只决定**消息调用**打到哪里，模型列表不一定在同一个地址上，见下文「获取不到模型列表」。

## 测试连接

在服务商列表中，点击 **测试** 按钮可以检测 API Key 是否有效。

测试成功后会显示该服务商下可用的模型列表，可以直接点击 **添加** 按钮批量导入模型。

## 获取不到模型列表

「获取模型列表」失败不一定代表配置有错：**消息接口与列表接口不总在同一个地址上**。典型的 Anthropic
兼容端点（如 DeepSeek 的 `https://api.deepseek.com/anthropic`）只实现消息接口 `/v1/messages`，没有
`/v1/models`，服务端会返回 404，而模型本身完全可用。

这类服务商有两种配置方式，任选其一：

- **手动输入模型 ID**：在服务商编辑器（新建或编辑）的「可用模型列表」区域，直接在输入框填写模型 ID
  （如 `deepseek-v4-pro`）并回车或点 **添加**，再保存；服务商列表页的模型行里也能补录模型。
- **改用 OpenAI 兼容地址获取列表**：把 Base URL 换成本服务商的 OpenAI 兼容根（DeepSeek 为
  `https://api.deepseek.com`），先取回列表并记下模型 ID，再按实际要用的协议改回对应地址。

列表接口取不到只影响"发现模型"这一步，模型保存后消息调用照常。

## 添加模型

展开某个服务商，点击底部的 **+ 添加模型** 按钮。

### 基本信息

| 字段 | 说明 | 示例 |
|------|------|------|
| 模型 ID | API 调用使用的标识 | `gpt-4-turbo` |
| 显示名称 | 界面显示的名称 | `GPT-4 Turbo` |
| 上下文限制 | 对话窗口大小（tokens） | `128000` |
| 输出限制 | 单次回复最大长度（tokens） | `4096` |

### 输入/输出模态

模型支持的数据类型：

- **输入模态**：text（文本）、image（图片）、audio（音频）、video（视频）、pdf（PDF）
- **输出模态**：text（文本）、image（图片）

点击标签即可切换，默认只支持文本。

### 高级参数

点击 **展开高级参数** 可配置：

| 参数 | 说明 |
|------|------|
| 启用思考模式 | 开启后模型会进行推理（Claude 3.7 等支持） |
| 思考预算 | 思考模式可用的最大 token 数 |
| 输入费用 | 每百万 tokens 的价格（美元） |
| 输出费用 | 每百万 tokens 的价格（美元） |

## 设置主模型

点击右上角的 **模型配置** 按钮，可以设置：

- **主模型**：Agent 默认使用的模型
- **轻量模型**：用于快速任务的低成本模型

## API Key 说明

保存后 API Key 只显示后 4 位（如 `***ab12`），完整内容会存储在环境变量中，配置文件只保留引用。

编辑服务商时 API Key 留空表示不修改。

## 批量删除

勾选多个服务商后，底部会出现批量操作栏，点击 **批量删除** 可以一次性删除。

## 常见问题

### API Key 在哪里获取？

| 服务商 | 地址 |
|--------|------|
| OpenAI | https://platform.openai.com/api-keys |
| Anthropic | https://console.anthropic.com/settings/keys |
| 阿里云百炼 | https://bailian.console.aliyun.com/ |

### 为什么保存后 API Key 变成了 `{env:xxx}`？

这是正常的安全机制，实际密钥已存储在环境变量中。

### 可以添加多个服务商吗？

可以，没有数量限制。

### 模型配置错了怎么办？

直接点击模型卡片上的 **编辑** 按钮修改，或点击 **删除** 移除。
