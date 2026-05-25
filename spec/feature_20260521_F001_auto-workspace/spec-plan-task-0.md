### Task 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**
- [x] 验证 TypeScript 类型检查可用
  - 运行命令: `bun run typecheck`
  - 预期: 无类型错误（当前代码基线通过）

**检查步骤:**
- [x] 后端构建无错误
  - `bun run typecheck 2>&1 | tail -5`
  - 预期: 输出无 error（已有 workflow-engine 类型错误，非本次引入）
- [x] 后端测试可用
  - `bun test src/__tests__/ 2>&1 | tail -10`
  - 预期: 测试框架运行，无配置错误
- [x] 前端构建无错误
  - `bun run build:web 2>&1 | tail -5`
  - 预期: 输出包含 "built in" 且无 error

---
