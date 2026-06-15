---
name: skill-creator
description: 帮助用户创建、编辑和优化 Agent Skill 指令文件。当用户提到"创建 skill"、"写技能"、"编辑 skill"、"优化技能"、"新建技能"或需要生成 SKILL.md 文件时使用。
required_skills:
  - agent-platform-api
---

# Skill Creator

帮助用户创建和迭代优化 Agent Skill 指令文件，并通过平台 API 注册到系统中。

## 创建流程

### 1. 理解意图

先弄清楚用户想要什么：
1. 这个 Skill 让 Agent 做什么？
2. 什么情况下触发？（用户可能的表述方式）
3. 期望的输出格式是什么？
4. 有没有参考示例或现有流程可以复用？

主动询问边界情况和特殊要求，减少返工。

### 2. 编写 SKILL.md

基于用户描述，生成结构化的 SKILL.md：

```
skill-name/
├── SKILL.md        （必需）
│   ├── YAML frontmatter（name + description 必填）
│   └── Markdown 指令正文
└── scripts/        （可选，辅助脚本）
```

#### Frontmatter 规范

- **name**：Skill 标识符，kebab-case
- **description**：触发描述。写明 Skill 做什么 + 什么时候用。描述要主动一些，覆盖用户可能的表述

#### 正文结构

按以下模板组织：

```markdown
# Skill 名称

一句话说明做什么。

## 触发条件
什么时候使用此 Skill。

## 工作流程
分步骤的操作指南。

## 输出规范
期望的输出格式和字段。

## 注意事项
边界条件和约束。

## 示例
1-2 个典型输入/输出。
```

### 3. 注册到平台

SKILL.md 写好后，通过平台 API 注册。参考 `agent-platform-api` 的 Skill 配置文档（`references/config.md` 中的「四、Skill」章节）。

**注册方式**：先用 Write tool 将 SKILL.md 写到 `.agents/skills/<name>/SKILL.md`，再用 `jq --rawfile` 从文件读取内容构造 JSON，通过 `POST /web/config/skills` + `action: "set"` 提交。

```bash
# --rawfile 直接从磁盘读文件，不经过 shell 解析，天然支持中文和特殊字符
jq -n --rawfile content .agents/skills/my-skill/SKILL.md \
  --arg name "my-skill" --arg desc "描述..." \
  '{action:"set", name:$name, data:{description:$desc, content:$content}}' | \
  curl -s -X POST "$USER_META_BASE_URL/web/config/skills" \
    -H "Authorization: Bearer $USER_META_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- | jq '.data | { name }'
```

注册后可通过 `action: "list"` 验证是否生效。

### 4. 编写原则

- 指令具体可执行，避免"请适当处理"这类模糊表述
- 用编号列表表达步骤顺序
- 解释为什么这样做，而不是堆砌 ALWAYS/NEVER
- 一个 Skill 聚焦单一职责
- 触发关键词覆盖用户可能的表达方式
- 保持 SKILL.md 在 200 行以内，太长说明职责不够聚焦

### 5. 迭代优化

用户反馈后调整：
- 从反馈中归纳通用问题，而非针对单个 case 修补
- 删掉没用的指令，保持精简
- 如果多个测试场景都重复了相同操作，考虑提取为辅助脚本
- 修改后通过 `action: "set"` 更新，无需重新创建
