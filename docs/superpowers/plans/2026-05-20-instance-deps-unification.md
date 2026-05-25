# Instance _deps Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the manual `_deps`/`_resetDeps` dependency injection pattern from `instance.ts`, unifying with the project's standard approach: direct imports + Bun `mock.module()` in tests.

**Architecture:** `instance.ts` currently uses a `_deps` object to hold 6 dependency references, with `_resetDeps()` to restore originals after tests. This is inconsistent with every other service file in the project, which uses direct imports and `mock.module()` for test injection. We replace `_deps` with direct imports, matching the established project convention (ADR-0001).

**Tech Stack:** Bun test `mock.module()`, direct ESM imports

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/services/instance.ts` | Remove `_deps`/`_resetDeps`, use direct imports |
| `src/__tests__/instance.test.ts` | New test file using `mock.module()` pattern |

---

### Task 1: Remove `_deps` object and restore direct imports

**Files:**
- Modify: `src/services/instance.ts`

- [ ] **Step 1: Replace all `_deps.xxx` references with direct imports**

In `src/services/instance.ts`:

1. Remove the `_deps` object definition and `_resetDeps` function (lines 18-34):

```typescript
// DELETE these lines:
export const _deps = {
  getCoreRuntime: _getCoreRuntime,
  buildLaunchSpec: _buildLaunchSpec,
  getAgentConfigById: _getAgentConfigById,
  getAgentFullConfig: _getAgentFullConfig,
  environmentRepo: _environmentRepo,
  findOrCreateForEnvironment: _findOrCreateForEnvironment,
};

export function _resetDeps() {
  _deps.getCoreRuntime = _getCoreRuntime;
  _deps.buildLaunchSpec = _buildLaunchSpec;
  _deps.getAgentConfigById = _getAgentConfigById;
  _deps.getAgentFullConfig = _getAgentFullConfig;
  _deps.environmentRepo = _environmentRepo;
  _deps.findOrCreateForEnvironment = _findOrCreateForEnvironment;
}
```

2. Change imports from aliased (`_getCoreRuntime`) to direct names:

```typescript
// Before:
import { getCoreRuntime as _getCoreRuntime } from "./core-bootstrap";
import { buildLaunchSpec as _buildLaunchSpec } from "./launch-spec-builder";
import { getAgentConfigById as _getAgentConfigById, getAgentFullConfig as _getAgentFullConfig } from "./config-pg";
import { environmentRepo as _environmentRepo } from "../repositories";
import { findOrCreateForEnvironment as _findOrCreateForEnvironment } from "./session";

// After:
import { getCoreRuntime } from "./core-bootstrap";
import { buildLaunchSpec } from "./launch-spec-builder";
import { getAgentConfigById, getAgentFullConfig } from "./config-pg";
import { environmentRepo } from "../repositories";
import { findOrCreateForEnvironment } from "./session";
```

3. Replace all `_deps.xxx()` calls throughout the file:

| Before | After |
|--------|-------|
| `_deps.getCoreRuntime()` | `getCoreRuntime()` |
| `_deps.buildLaunchSpec(...)` | `buildLaunchSpec(...)` |
| `_deps.getAgentConfigById(...)` | `getAgentConfigById(...)` |
| `_deps.getAgentFullConfig(...)` | `getAgentFullConfig(...)` |
| `_deps.environmentRepo.getById(...)` | `environmentRepo.getById(...)` |
| `_deps.findOrCreateForEnvironment(...)` | `findOrCreateForEnvironment(...)` |

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: No errors — all function signatures remain the same

- [ ] **Step 3: Find and fix any tests that use `_deps` or `_resetDeps`**

Run: `grep -rn "_deps\|_resetDeps" src/__tests__/`

For any test files found:
1. Remove `import { _deps, _resetDeps }` imports
2. Remove `afterEach(() => _resetDeps())` cleanup calls
3. Replace `import { instance } from "../services/instance"; _deps.someFunc = mockFn;` with `mock.module("../services/core-bootstrap", () => ({ getCoreRuntime: mockFn }))` at the top of the test file (before any imports of the module under test)
4. Remove any `afterAll/afterEach` that reset deps

The Bun test `mock.module()` pattern:
```typescript
import { mock } from "bun:test";

// Must be called before importing the module that uses the dependency
mock.module("../services/core-bootstrap", () => ({
  getCoreRuntime: () => mockCoreRuntime,
}));

// Then import the module under test
import { spawnInstanceFromEnvironment } from "../services/instance";
```

- [ ] **Step 4: Run all tests**

Run: `bun test src/__tests__/`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/services/instance.ts src/__tests__/
git commit -m "refactor: remove instance.ts _deps manual DI, use direct imports + mock.module"
```

---

### Task 2: Verify no other files use the `_deps` pattern

**Files:**
- Search across entire `src/` directory

- [ ] **Step 1: Grep for any remaining `_deps` usage**

Run: `grep -rn "_deps\._resetDeps" src/ --include="*.ts"`

Expected: No results. If any are found, apply the same transformation as Task 1.

- [ ] **Step 2: Final verification**

Run: `bun run typecheck && bun test src/__tests__/ && bun run build:web`

Expected: All pass

- [ ] **Step 3: Commit any remaining changes**

```bash
git add -A
git commit -m "refactor: clean up remaining _deps patterns across codebase"
```
