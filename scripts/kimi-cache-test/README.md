# Kimi API 缓存命中率测试工具

验证 `api.kimi.com/coding`（Anthropic 协议）的多轮对话缓存行为。
system prompt 内嵌运行时间戳，确保每次测试都是全新请求，排除旧缓存干扰。

## 快速开始

```bash
# 设置 API Key
export KIMI_API_KEY="sk-kimi-xxx"

# 运行全部测试
python3 scripts/kimi-cache-test/run.py

# 只运行指定测试
python3 scripts/kimi-cache-test/run.py anthropic-prefix
python3 scripts/kimi-cache-test/run.py anthropic-cache-control anthropic-cache-key

# 直接传 key，自定义间隔
python3 scripts/kimi-cache-test/run.py --key sk-kimi-xxx --interval 3
```

## 测试项

| 名称 | 验证内容 |
|------|---------|
| `anthropic-prefix` | 无缓存参数，4 轮递增 + 1 轮重复，观察 prefix 缓存 |
| `anthropic-cache-control` | system/messages 带 `cache_control: ephemeral`，观察 breakpoint 是否生效 |
| `anthropic-cache-key` | 无 key vs 有 `prompt_cache_key`，4+4 轮对比 |

## 输出结构

```
logs/<timestamp>/
├── report.md                          # 汇总报告 (表格 + 结论)
├── requests.jsonl                     # 全部请求/响应原始数据 (每行一个 JSON)
├── anthropic-prefix/
│   ├── test.log                       # 纯文本日志，无特殊符号
│   ├── round_01.json                  # 每轮完整请求体 + 响应体
│   └── ...
├── anthropic-cache-control/
│   └── ...
└── anthropic-cache-key/
    └── ...
```

`test.log` 为纯文本（无 ANSI 颜色码、无 Unicode 装饰符号），可直接发给开发者。

`round_*.json` 每个文件是一个完整的请求/响应记录，包含 `timestamp`、`request`、`response`、`http_code`、`latency_ms` 等字段。

## 无外部依赖

仅使用 Python 标准库（`urllib`、`json`、`argparse`），无需安装第三方包。

---

## 测试结论

测试日期：2026-05-25

测试端点：`https://api.kimi.com/coding/v1/messages`（Anthropic 协议，模型 `kimi-for-coding`）

### 核心发现

**1. `cache_creation_input_tokens` 始终为 0**

在所有 15 个请求中，`cache_creation_input_tokens` 均为 0。即使请求体中显式传入了 `cache_control: {"type": "ephemeral"}`（标准 Anthropic prefix caching 标记），服务端也没有报告任何缓存写入。说明该端点没有实现 Anthropic 的 cache_control breakpoint 机制，该参数被静默忽略（不报错，但也不生效）。

**2. 缓存基于请求全文 hash，不是 prefix matching**

关键证据来自两次独立测试的对比：

- **首次测试（冷启动）**：多轮递增对话中，轮次 2、3 追加了新消息（前缀相同但内容不同），`cache_read` 均为 0。仅轮次 4（与轮次 3 完全相同）才命中缓存。
- **最终测试（热启动）**：同样的测试用例，轮次 2、3 也 100% 命中了缓存。

轮次 2、3 在最终测试中命中，并非因为 prefix caching 生效，而是因为**这些完全相同的消息组合在之前的手动调试中已经请求过**，服务端缓存了完整的请求内容。

结论：缓存匹配的粒度是**整个请求体**（system + 全部 messages 的全文 hash），而非 Anthropic 标准的 prefix matching（前 N 条消息相同即命中）。这意味着在实际多轮对话中，每次追加新消息后，之前的历史消息不会被缓存复用。

**3. `prompt_cache_key` 参数无稳定效果**

对比测试（无 key vs 有 key，各 4 轮递增对话）显示：
- 两组测试的 `cache_read` 均为 0
- `prompt_cache_key` 的存在与否对缓存命中率没有可观测的稳定影响

该参数在 Kimi 的 OpenAI 兼容端点文档中有说明，但在 Anthropic 协议端点上未体现出预期效果。

### 总结判定

| 缓存机制 | 是否生效 | 证据 |
|----------|---------|------|
| Anthropic `cache_control` breakpoint | 未实现 | 所有 15 个请求 `cache_creation` = 0，参数被静默忽略 |
| Anthropic 标准 prefix caching | 未实现 | 前缀相同但追加了新消息时，`cache_read` 始终为 0 |
| 请求全文 hash 缓存 | 有 | 完全相同的请求命中；之前发过的请求组合再次发送也命中 |
| `prompt_cache_key` 参数 | 无效果 | 有无对比测试的 `cache_read` 无差异 |

### 对 Coding Agent 场景的影响

使用 `api.kimi.com/coding` 端点构建多轮 Coding Agent 时：

1. **token 成本不受控**：每轮对话的 system prompt 和历史消息无法被缓存复用，实际按全量 token 计费
2. **不可依赖缓存优化**：服务端缓存基于全文 hash，对多轮对话无实际优化效果
3. **建议客户端侧控上下文**：在客户端实现上下文窗口管理（截断/压缩历史消息），主动控制 prompt_tokens 增长
