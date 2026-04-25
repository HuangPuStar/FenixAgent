# Permission Config Enhancement 人工验收清单

**生成时间:** 2026-04-25 00:00
**关联计划:** spec/feature_20260425_F001_permission-config-enhancement/spec-plan.md
**关联设计:** spec/feature_20260425_F001_permission-config-enhancement/spec-design.md

---

## 验收前准备

### 环境要求
- [ ] [AUTO] 检查 Bun 运行时版本: `bun --version`
- [ ] [AUTO] 检查 Node 运行时版本: `node --version`
- [ ] [AUTO] 编译前端: `cd /Users/konghayao/code/pazhou/remote-control-server/web && bunx vite build`
- [ ] [AUTO] TypeScript 类型检查: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck`
- [ ] [AUTO/SERVICE] 启动 RCS 服务: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev` (port: 3000)

### 测试数据准备
- [ ] [AUTO] 备份当前 opencode 配置: `cp ~/.config/opencode/config.json ~/.config/opencode/config.json.bak 2>/dev/null; echo "备份完成或无现有配置"`
- [ ] [AUTO] 创建含 tools 字段的测试 agent 配置（用于兼容转换验证）: 需在 opencode.json 中手动添加含 `tools: { "bash": true, "read": false }` 的测试 agent
- [ ] [AUTO] 确认 opencode.json 路径: `ls -la ~/.config/opencode/config.json`

---

## 验收项目

### 场景 1：Skills 目录迁移

#### - [x] 1.1 SkillService 使用新路径 ~/.agents/skills/
- **来源:** spec-plan.md 验收标准 / spec-design.md §Skills 目录迁移
- **目的:** 确认 SkillService 存储路径已切换
- **操作步骤:**
  1. [A] `grep -r "agents/skills" /Users/konghayao/code/pazhou/remote-control-server/src/services/skill.ts` → 期望包含: `agents/skills`
  2. [A] `grep -r "config/opencode/skills" /Users/konghayao/code/pazhou/remote-control-server/src/services/skill.ts` → 期望包含: (空结果，旧路径不应存在)

#### - [x] 1.2 旧目录数据自动迁移到新目录
- **来源:** spec-plan.md 验收标准 / spec-design.md §迁移流程
- **目的:** 确认旧数据迁移后完整性
- **操作步骤:**
  1. [A] `mkdir -p ~/.config/opencode/skills && echo "test-skill-content" > ~/.config/opencode/skills/test-skill.md && rm -rf ~/.agents/skills` → 准备旧目录数据
  2. [A] 重启 RCS 服务后检查: `ls ~/.agents/skills/test-skill.md` → 期望包含: `test-skill.md`

#### - [x] 1.3 迁移标记文件防止重复迁移
- **来源:** spec-design.md §迁移幂等性
- **目的:** 确认 .migrated 标记文件存在
- **操作步骤:**
  1. [A] 迁移执行后: `ls ~/.config/opencode/skills/.migrated` → 期望包含: `.migrated`

#### - [x] 1.4 新目录已存在时跳过迁移
- **来源:** spec-design.md §迁移流程
- **目的:** 确认幂等性，不覆盖已有新数据
- **操作步骤:**
  1. [A] `mkdir -p ~/.agents/skills && echo "existing-data" > ~/.agents/skills/existing.md` → 模拟新目录已有数据
  2. [A] 重启 RCS 服务后: `cat ~/.agents/skills/existing.md` → 期望包含: `existing-data`

#### - [x] 1.5 旧目录不存在时创建新目录
- **来源:** spec-design.md §迁移流程
- **目的:** 确认全新安装场景正常
- **操作步骤:**
  1. [A] `rm -rf ~/.config/opencode/skills ~/.agents/skills` → 清理
  2. [A] 重启 RCS 服务后: `ls -d ~/.agents/skills` → 期望包含: `.agents/skills`

---

### 场景 2：tools → permission 兼容转换

#### - [x] 2.1 旧 tools 布尔值自动转换为 permission 三态
- **来源:** spec-plan.md 验收标准 / spec-design.md §tools → permission 兼容转换逻辑
- **目的:** 确认 true→allow, false→deny 转换正确
- **操作步骤:**
  1. [A] 在 opencode.json 中设置测试 agent 含 `"tools": { "bash": true, "read": false }` 但无 `permission` 字段
  2. [A] `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"get","name":"<测试agent名>"}' | python3 -m json.tool` → 期望包含: `"permission"` 和 `"bash": "allow"` 和 `"read": "deny"`

#### - [x] 2.2 写入时清除旧 tools 字段
- **来源:** spec-design.md §实现要点 1
- **目的:** 确认保存后 tools 字段被清除
- **操作步骤:**
  1. [A] 通过 API 设置 agent permission 后: `cat ~/.config/opencode/config.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('agent',{}).get('<测试agent名>',{}).get('tools','NOT_FOUND'))"` → 期望包含: `NOT_FOUND`

#### - [x] 2.3 permission 已存在时不使用 tools 字段
- **来源:** spec-design.md §实现要点 1
- **目的:** 确认 permission 优先于 tools
- **操作步骤:**
  1. [A] 在 opencode.json 中设置测试 agent 同时含 `tools` 和 `permission` 字段
  2. [A] 通过 API 读取该 agent: `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"get","name":"<测试agent名>"}'` → 期望包含: permission 值来自 `permission` 字段而非 `tools`

---

### 场景 3：Agent Permission UI

#### - [x] 3.1 Agent 编辑弹窗显示两个 Tab
- **来源:** spec-plan.md 验收标准 / spec-design.md §Agent Permission UI 设计
- **目的:** 确认 Tab 结构正确
- **操作步骤:**
  1. [H] 打开 `http://localhost:3000`，进入 Settings → Agents 页面，点击任一 agent 编辑按钮 → 观察弹窗顶部是否显示"基础配置"和"权限配置"两个 Tab → 是/否

#### - [x] 3.2 Permission Tab 工具权限分区正确
- **来源:** spec-plan.md 验收标准
- **目的:** 确认开关型和规则型工具分区显示
- **操作步骤:**
  1. [H] 切换到"权限配置" Tab → 观察是否显示"工具权限"区域并区分开关型和规则型 → 是/否

#### - [x] 3.3 开关型工具各显示三态 Select
- **来源:** spec-plan.md 验收标准
- **目的:** 确认 6 个开关型工具 UI 正确
- **操作步骤:**
  1. [H] 在权限配置 Tab 中 → 观察是否显示 todowrite、question、webfetch、websearch、codesearch、doom_loop 六个工具，每个有"未设置/ask/allow/deny"的 Select → 是/否

#### - [x] 3.4 规则型工具支持展开通配符规则编辑器
- **来源:** spec-plan.md 验收标准
- **目的:** 确认规则型工具展开交互正确
- **操作步骤:**
  1. [H] 在权限配置 Tab 中 → 观察规则型工具（read/edit/glob/grep/list/bash/task/external_directory/lsp）是否各有全局策略 Select + 展开按钮 → 是/否
  2. [H] 点击任一规则型工具的展开按钮 → 观察是否显示通配符规则编辑器（pattern 输入框 + action Select + 删除按钮 + 添加规则按钮） → 是/否

#### - [x] 3.5 Skill 权限区展示 skill 名称列表
- **来源:** spec-plan.md 验收标准
- **目的:** 确认 Skill 权限实时联动
- **操作步骤:**
  1. [H] 在权限配置 Tab 中 → 观察"Skill 权限"区域是否列出所有已安装 skill 名称，每个有权限 Select → 是/否

#### - [x] 3.6 Skill 权限支持手动添加通配符模式
- **来源:** spec-plan.md 验收标准 / spec-design.md §交互要点
- **目的:** 确认自定义 Skill 规则可添加
- **操作步骤:**
  1. [H] 在 Skill 权限区 → 观察是否有"添加自定义规则"按钮 → 是/否
  2. [H] 点击添加自定义规则 → 输入通配符 `internal-*` → 选择 action → 点击保存 → 观察是否成功保存 → 是/否

#### - [x] 3.7 原有"工具"Checkbox 多选组已移除
- **来源:** spec-design.md §交互要点
- **目的:** 确认旧 UI 已被 Permission Tab 取代
- **操作步骤:**
  1. [H] 在 Agent 编辑弹窗中 → 观察是否不再显示旧的"工具"Checkbox 多选组 → 是/否

---

### 场景 4：Agent 新字段 API 验证

#### - [x] 4.1 Agent API get 返回新增字段
- **来源:** spec-plan.md 验收标准 / spec-design.md §API 变更汇总
- **目的:** 确认 API 响应包含新字段
- **操作步骤:**
  1. [A] `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"get","name":"<任一agent>"}' | python3 -m json.tool` → 期望包含: `"variant"` 和 `"temperature"` 和 `"top_p"` 和 `"disable"` 和 `"hidden"` 和 `"color"` 和 `"description"` 和 `"permission"`

#### - [x] 4.2 Agent API set 保存新增字段
- **来源:** spec-design.md §API 变更汇总
- **目的:** 确认新字段可写入
- **操作步骤:**
  1. [A] `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"set","name":"<测试agent>","data":{"variant":"thinking","temperature":0.7,"top_p":0.9,"disable":false,"hidden":false,"color":"#3B82F6","description":"测试描述"}}'` → 期望包含: `"success"` (或类似成功标识)
  2. [A] 读回验证: `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"get","name":"<测试agent>"}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('variant',''),d.get('data',{}).get('temperature',''),d.get('data',{}).get('color',''))"` → 期望包含: `thinking 0.7 #3B82F6`

#### - [x] 4.3 新字段正确写入 opencode.json
- **来源:** spec-plan.md 验收标准
- **目的:** 确认写入格式被 OpenCode CLI 兼容
- **操作步骤:**
  1. [A] `cat ~/.config/opencode/config.json | python3 -c "import json,sys;d=json.load(sys.stdin);a=d.get('agent',{}).get('<测试agent>',{});print(a.get('variant',''),a.get('temperature',''),a.get('description',''))"` → 期望包含: `thinking 0.7 测试描述`

---

### 场景 5：Permission 读写端到端验证

#### - [x] 5.1 设置 permission 对象并读回验证
- **来源:** spec-plan.md 验收标准
- **目的:** 确认 permission 完整读写链路
- **操作步骤:**
  1. [A] `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"set","name":"<测试agent>","data":{"permission":{"bash":"deny","read":{"*.env":"deny","*":"allow"},"skill":{"internal-*":"allow","pr-review":"deny"}}}}'` → 期望包含: `"success"`
  2. [A] 读回: `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"get","name":"<测试agent>"}' | python3 -m json.tool` → 期望包含: `"bash": "deny"` 和 `"*.env": "deny"` 和 `"internal-*": "allow"`

#### - [x] 5.2 permission 字符串模式（全局策略）正确读写
- **来源:** spec-design.md §PermissionConfig 结构
- **目的:** 确认全局策略字符串格式正确
- **操作步骤:**
  1. [A] `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"set","name":"<测试agent>","data":{"permission":"ask"}}'` → 期望包含: `"success"`
  2. [A] 读回: `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"get","name":"<测试agent>"}' | python3 -c "import json,sys;print(type(json.load(sys.stdin).get('data',{}).get('permission','')).__name__)"` → 期望包含: `str`

#### - [x] 5.3 "未设置"权限项不写入配置
- **来源:** spec-design.md §交互要点
- **目的:** 确认未设置字段被正确省略
- **操作步骤:**
  1. [A] 设置 permission 时部分工具不传（模拟"未设置"），然后检查 opencode.json 中对应 agent 的 permission 对象 → 未传的工具不应出现在 permission 对象中 → 期望精确: `true` (通过检查确认)

#### - [x] 5.4 规则型工具通配符规则正确持久化
- **来源:** spec-design.md §PermissionConfig 结构
- **目的:** 确认规则型工具对象格式正确
- **操作步骤:**
  1. [A] `cat ~/.config/opencode/config.json | python3 -c "import json,sys;d=json.load(sys.stdin);p=d.get('agent',{}).get('<测试agent>',{}).get('permission',{});print(type(p.get('read')).__name__ if isinstance(p,dict) and 'read' in p else 'NOT_SET')"` → 期望包含: `dict`

---

### 场景 6：Models API permission 透传

#### - [x] 6.1 Models API get 返回顶层 permission 字段
- **来源:** spec-plan.md 验收标准 / spec-design.md §Models API
- **目的:** 确认 Models API 支持 permission 读取
- **操作步骤:**
  1. [A] `curl -s http://localhost:3000/web/config/models -H 'Content-Type: application/json' -d '{"action":"get","name":"<任一model>"}' | python3 -m json.tool` → 期望包含: `"permission"` (字段存在，值可为 null)

#### - [x] 6.2 Models API set 写入顶层 permission 字段
- **来源:** spec-design.md §Models API
- **目的:** 确认 Models API 支持 permission 写入
- **操作步骤:**
  1. [A] `curl -s http://localhost:3000/web/config/models -H 'Content-Type: application/json' -d '{"action":"set","name":"<测试model>","data":{"permission":{"bash":"allow"}}}'` → 期望包含: `"success"`
  2. [A] 读回验证: `curl -s http://localhost:3000/web/config/models -H 'Content-Type: application/json' -d '{"action":"get","name":"<测试model>"}' | python3 -c "import json,sys;d=json.load(sys.stdin);p=d.get('data',{}).get('permission');print(p)"` → 期望包含: `bash`

---

### 场景 7：边界与回归

#### - [x] 7.1 迁移冲突时降级运行不阻塞启动
- **来源:** spec-design.md §迁移策略细节
- **目的:** 确认迁移失败不影响服务
- **操作步骤:**
  1. [A] 设置新目录和旧目录同时存在且都有内容 → 启动 RCS 服务 → 期望包含: 服务正常启动日志

#### - [x] 7.2 temperature 范围 0-2、top_p 范围 0-1 校验
- **来源:** spec-design.md §实现要点 5
- **目的:** 确认数值字段边界正确
- **操作步骤:**
  1. [A] `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"set","name":"<测试agent>","data":{"temperature":2.0,"top_p":1.0}}'` → 期望包含: `"success"`
  2. [A] `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"set","name":"<测试agent>","data":{"temperature":3.0}}'` → 期望包含: (错误提示或被拒绝)

#### - [x] 7.3 color 字段 hex 值和预设主题色名均可接受
- **来源:** spec-design.md §实现要点 5
- **目的:** 确认 color 格式兼容性
- **操作步骤:**
  1. [A] `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"set","name":"<测试agent>","data":{"color":"#FF5500"}}'` → 期望包含: `"success"`
  2. [A] `curl -s http://localhost:3000/web/config/agents -H 'Content-Type: application/json' -d '{"action":"set","name":"<测试agent>","data":{"color":"primary"}}'` → 期望包含: `"success"`

#### - [x] 7.4 TypeScript 类型定义正确
- **来源:** spec-plan.md / spec-design.md
- **目的:** 确认类型安全无编译错误
- **操作步骤:**
  1. [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck` → 期望包含: (无错误输出)

---

## 验收后清理

- [ ] [AUTO] 恢复 opencode 配置备份: `cp ~/.config/opencode/config.json.bak ~/.config/opencode/config.json 2>/dev/null; echo "已恢复"`
- [ ] [AUTO] 终止后台服务 RCS: `kill $(lsof -ti:3000) 2>/dev/null; echo "已终止"`
- [ ] [AUTO] 清理测试 skill 数据: `rm -rf ~/.agents/skills/test-skill.md ~/.agents/skills/existing.md 2>/dev/null; echo "已清理"`

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | SkillService 使用新路径 | 1 | 0 | ⬜ |
| 场景 1 | 1.2 | 旧目录数据自动迁移 | 2 | 0 | ⬜ |
| 场景 1 | 1.3 | 迁移标记文件防重复 | 1 | 0 | ⬜ |
| 场景 1 | 1.4 | 新目录已存在时跳过 | 2 | 0 | ⬜ |
| 场景 1 | 1.5 | 旧目录不存在时创建新目录 | 2 | 0 | ⬜ |
| 场景 2 | 2.1 | tools 布尔值转 permission 三态 | 2 | 0 | ⬜ |
| 场景 2 | 2.2 | 写入时清除旧 tools 字段 | 1 | 0 | ⬜ |
| 场景 2 | 2.3 | permission 优先于 tools | 2 | 0 | ⬜ |
| 场景 3 | 3.1 | Agent 编辑弹窗两个 Tab | 0 | 1 | ⬜ |
| 场景 3 | 3.2 | 工具权限分区显示 | 0 | 1 | ⬜ |
| 场景 3 | 3.3 | 开关型工具三态 Select | 0 | 1 | ⬜ |
| 场景 3 | 3.4 | 规则型工具展开编辑器 | 0 | 2 | ⬜ |
| 场景 3 | 3.5 | Skill 权限列表展示 | 0 | 1 | ⬜ |
| 场景 3 | 3.6 | Skill 通配符模式添加 | 0 | 2 | ⬜ |
| 场景 3 | 3.7 | 旧 Checkbox 已移除 | 0 | 1 | ⬜ |
| 场景 4 | 4.1 | API 返回新增字段 | 1 | 0 | ⬜ |
| 场景 4 | 4.2 | API 保存新增字段 | 2 | 0 | ⬜ |
| 场景 4 | 4.3 | 新字段写入 opencode.json | 1 | 0 | ⬜ |
| 场景 5 | 5.1 | Permission 对象读写验证 | 2 | 0 | ⬜ |
| 场景 5 | 5.2 | Permission 字符串模式读写 | 2 | 0 | ⬜ |
| 场景 5 | 5.3 | 未设置项不写入配置 | 1 | 0 | ⬜ |
| 场景 5 | 5.4 | 通配符规则正确持久化 | 1 | 0 | ⬜ |
| 场景 6 | 6.1 | Models API 返回 permission | 1 | 0 | ⬜ |
| 场景 6 | 6.2 | Models API 写入 permission | 2 | 0 | ⬜ |
| 场景 7 | 7.1 | 迁移冲突降级运行 | 1 | 0 | ⬜ |
| 场景 7 | 7.2 | temperature/top_p 范围校验 | 2 | 0 | ⬜ |
| 场景 7 | 7.3 | color 格式兼容性 | 2 | 0 | ⬜ |
| 场景 7 | 7.4 | TypeScript 类型检查通过 | 1 | 0 | ⬜ |

**验收结论:** ⬜ 全部通过 / ⬜ 存在问题
