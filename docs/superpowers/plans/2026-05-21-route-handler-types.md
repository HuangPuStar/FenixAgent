# Elysia Route Handler Type Safety Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all `: any` and `as any` type casts from route handlers by converting the `sessionAuth` macro from `beforeHandle` + state mutation to `resolve` + context decoration, enabling full Elysia type inference for `store.user`, `store.authContext`, `body`, `error`, and `params`.
**Architecture:** The `authGuardPlugin` currently uses `.state()` with nullable types and `beforeHandle` to mutate store, which breaks Elysia's type inference. The fix converts the `sessionAuth` macro to use `resolve` (Elysia's native pattern for adding typed context properties), returning `{ user: UserInfo; authContext: AuthContext }` as non-nullable properties that flow directly into handler context types. All 19 route files are then updated to remove `: any` annotations, `as any` casts, non-null assertions (`!`), and `biome-ignore` suppressions.
**Tech Stack:** Elysia 1.4.x macro system (resolve pattern), TypeScript, Biome lint

---

## File Structure

### Modified files
| File | Responsibility |
|------|---------------|
| `src/plugins/auth.ts` | Convert `sessionAuth` macro from `beforeHandle` to `resolve`; keep `setTestAuth`/`resetTestAuth` working; export typed context interfaces |
| `src/routes/web/tasks.ts` | Remove `: any` from all 9 handlers; remove `biome-ignore` comments |
| `src/routes/web/organizations.ts` | Remove `: any` from 2 handlers; remove `biome-ignore` comments |
| `src/routes/web/instances.ts` | Remove `: any` from 2 handlers; remove `biome-ignore` comments |
| `src/routes/web/knowledge-bases.ts` | Remove `: any` from 8 handlers; remove `biome-ignore` comments |
| `src/routes/web/workflow-defs.ts` | Remove `: any` from 1 handler; remove `biome-ignore` comment |
| `src/routes/web/workflow-engine.ts` | Remove `: any` from 1 handler; remove `biome-ignore` comment |
| `src/routes/web/meta-agent.ts` | Remove `: any` from 1 handler; remove `biome-ignore` comment |
| `src/routes/web/config/providers.ts` | Remove `: any` from 1 handler; remove `biome-ignore` comment |
| `src/routes/web/config/agents.ts` | Remove `: any` from 1 handler; remove `biome-ignore` comment |
| `src/routes/web/config/skills.ts` | Remove `: any` from 2 handlers; remove `biome-ignore` comments |
| `src/routes/web/config/models.ts` | Remove `: any` from 1 handler; remove `biome-ignore` comment |
| `src/routes/web/config/mcp.ts` | Remove `: any` from 1 handler; remove `biome-ignore` comment |
| `src/routes/web/environments.ts` | Remove `store.authContext!` non-null assertions from 7 handlers |
| `src/routes/web/sessions.ts` | Remove `store.authContext!` non-null assertions from 3 handlers |
| `src/routes/web/files.ts` | Remove `store.authContext!` non-null assertions from 5 handlers; remove `(params as any)` casts |
| `src/routes/web/channels.ts` | Remove `store.authContext!` non-null assertions from 4 handlers |
| `src/routes/web/control.ts` | Remove `store.authContext?.` optional chaining from 3 handlers |
| `src/routes/web/s3-files.ts` | Remove `store.authContext?.` optional chaining from 5 handlers |
| `src/routes/web/user-file.ts` | Remove `store.authContext!` non-null assertions from 4 handlers |
| `src/routes/web/auth.ts` | Remove `store.authContext` nullable access from 1 handler |
| `src/routes/web/workflow-proxy.ts` | No changes needed (handlers don't access store) |

### Test files (update imports/usage to match new API)
| File | Responsibility |
|------|---------------|
| `src/__tests__/config-providers.test.ts` | Verify `setTestAuth` still works with `resolve`-based macro |
| `src/__tests__/config-agents.test.ts` | Verify `setTestAuth` still works |
| `src/__tests__/config-integration.test.ts` | Verify `setTestAuth` still works |
| `src/__tests__/config-mcp-network.test.ts` | Verify `setTestAuth` still works |
| `src/__tests__/config-mcp.test.ts` | Verify `setTestAuth` still works |
| `src/__tests__/config-models.test.ts` | Verify `setTestAuth` still works |
| `src/__tests__/permission-flow.test.ts` | Verify `setTestAuth` still works |
| `src/__tests__/workflow-proxy.test.ts` | Verify `setTestAuth` still works |

---

## Tasks

### Task 1: Convert sessionAuth macro to resolve pattern

**Files:**
- Modify: `src/plugins/auth.ts`

This is the core change. The `sessionAuth` macro currently uses `beforeHandle` to mutate `store` fields. Per Elysia docs, the correct pattern is to use `resolve` which adds typed properties to the handler context. The `resolve` function runs after validation (like `beforeHandle`) but its return type flows into TypeScript inference.

Key design decisions:
1. Keep `_testAuth` injection mechanism working -- `resolve` can check the test auth override
2. Keep `.state()` declarations for backward compatibility during migration, but the macro's `resolve` will also return the typed values
3. The `resolve` returns `{ user: UserInfo; authContext: AuthContext }` as non-nullable when `sessionAuth: true`
4. Error responses (401) are returned via `return status(401, ...)` from resolve (Elysia pattern)
5. Keep `store` mutation as a runtime side effect for any code that still reads `store.authContext` directly

- [ ] **Step 1: Replace the `sessionAuth` macro implementation with `resolve` pattern**

Replace the entire `sessionAuth` macro definition in `src/plugins/auth.ts`. The new implementation uses `resolve` instead of `beforeHandle` + store mutation. This gives Elysia full type inference.

Find the existing `sessionAuth` macro block (approximately lines 117-142):
```typescript
    sessionAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        // biome-ignore lint/suspicious/noExplicitAny: Elysia macro context type not fully expressible
        beforeHandle: async ({ store, request, error }: any) => {
          // ... entire beforeHandle body
        },
      };
    },
```

Replace with:
```typescript
    sessionAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        resolve: async ({ store, request }: {
          store: {
            user: UserInfo | null;
            authSession: AuthSessionInfo | null;
            authEnvironmentId: string | null;
            uuid: string | null;
            authContext: AuthContext | null;
          };
          request: Request;
        }): Promise<
          | { user: UserInfo; authContext: AuthContext }
          | Response
        > => {
          // 测试注入：直接返回预设的 user 和 authContext
          if (_testAuth) {
            store.user = _testAuth.user;
            store.authSession = _testAuth.session;
            if (_testAuth.authContext) store.authContext = _testAuth.authContext;
            return {
              user: _testAuth.user,
              authContext: _testAuth.authContext ?? { organizationId: "", userId: _testAuth.user.id, role: "member" as const },
            };
          }

          const session = await auth.api.getSession({ headers: request.headers });
          if (!session?.user) {
            return errorResponse(401, { error: { type: "unauthorized", message: "Not authenticated" } });
          }

          const user: UserInfo = { id: session.user.id, email: session.user.email, name: session.user.name };
          store.user = user;
          store.authSession = {
            id: session.session.id,
            userId: session.session.userId,
            token: session.session.token,
          };

          // 加载组织上下文
          const { loadOrgContext } = await import("../services/org-context");
          const ctx = await loadOrgContext(user, request);
          if (ctx) {
            store.authContext = ctx;
          }

          return {
            user,
            authContext: ctx ?? { organizationId: user.id, userId: user.id, role: "member" as const },
          };
        },
      };
    },
```

Note: The `resolve` function returns either the typed auth context object OR an error `Response`. Elysia handles both correctly -- if a `Response` is returned from resolve, it short-circuits the request (same behavior as `beforeHandle` returning a value).

- [ ] **Step 2: Remove the remaining `biome-ignore` comments from other macros that are unaffected**

In `src/plugins/auth.ts`, the `apiKeyAuth`, `uuidAuth`, and `sessionIngressAuth` macros also have `// biome-ignore lint/suspicious/noExplicitAny` comments on their `beforeHandle` callbacks. These macros are **not** being converted in this task (they are used in ACP routes, not web routes), so their `beforeHandle` pattern stays. However, the `any` type annotations on their destructured params are still needed.

No changes needed for these macros in this step.

- [ ] **Step 3: Verify the type inference works by running typecheck**

```bash
bun run typecheck
```

At this point, the route files that already don't use `: any` (Pattern A files like environments.ts, sessions.ts) will start getting a type error because they destructure `store` and access `store.authContext!` but now the context also has a top-level `authContext` property from resolve. This is expected -- these files will be migrated in Task 3.

---

### Task 2: Create a typed route context type helper

**Files:**
- Modify: `src/plugins/auth.ts`

Add an exported type alias for the resolved context that handlers can optionally use for documentation or when extracting handlers into standalone functions. This is not required for inline handlers (Elysia infers types automatically), but is useful for the handler extraction pattern used in config routes (e.g., `handleList`, `handleGet` in providers.ts).

- [ ] **Step 1: Add exported types for resolved auth context**

Add these type exports at the top of `src/plugins/auth.ts` (after the existing `AuthContext` interface), before the `_testAuth` declaration:

```typescript
/** Non-nullable auth context available in handlers with sessionAuth: true */
export type ResolvedAuthContext = {
  user: UserInfo;
  authContext: AuthContext;
};

/** Full typed context for session-authenticated route handlers.
 *  Use this type when extracting handler functions out of inline closures. */
export type SessionAuthContext = {
  user: UserInfo;
  authContext: AuthContext;
  error: (status: number, body: unknown) => Response;
  request: Request;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  set: {
    status?: number;
    headers: Record<string, string>;
    redirect?: string;
  };
};
```

These types are purely optional convenience exports. Inline handlers get full type inference from Elysia automatically. They are only needed for extracted handler functions like `handleList(ctx: AuthContext)` in config routes.

---

### Task 3: Migrate Pattern B route files (remove `: any`)

These are the route files where handlers explicitly use `: any` type annotations. After Task 1, Elysia will infer `user` and `authContext` as non-nullable top-level context properties when `sessionAuth: true` is set. The migration for each file follows the same pattern:

**Before:**
```typescript
async ({ store, body, error }: any) => {
  const authCtx = store.authContext!;
  const payload = body as SomeType;
```

**After:**
```typescript
async ({ user, authContext, body, error }) => {
  // authContext is now typed as non-nullable AuthContext
  const payload = body as SomeType; // body type depends on .model() registration
```

**Important**: After the `resolve` change, handlers receive `user` and `authContext` as top-level context properties (destructured directly), not through `store`. The `store.authContext` still exists at runtime (we still mutate it in the resolve body) but TypeScript will see the resolved properties as the authoritative typed versions.

#### Task 3a: Migrate `src/routes/web/tasks.ts`

**Files:**
- Modify: `src/routes/web/tasks.ts`

- [ ] **Step 1: Replace all 9 handler signatures**

For each handler in tasks.ts, make these changes:
1. Remove `: any` from the destructured context
2. Remove `// biome-ignore lint/suspicious/noExplicitAny:` comments
3. Replace `store.authContext!` with `authContext` (destructured from context)
4. Replace `store.user!` with `user` (destructured from context)
5. Remove `request: _request` if unused (or keep if handler signature needs it for Elysia inference)
6. Remove `body as CreateTaskRequest` / `body as UpdateTaskRequest` casts -- body type is inferred from `.model()` registration when present

For the GET /tasks handler:
```typescript
// BEFORE:
app.get(
  "/tasks",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, request: _request }: any) => {
    const authCtx = store.authContext!;
    const result = await listTasks(authCtx.organizationId);
    return result;
  },
  { sessionAuth: true },
);

// AFTER:
app.get(
  "/tasks",
  async ({ authContext }) => {
    const result = await listTasks(authContext.organizationId);
    return result;
  },
  { sessionAuth: true },
);
```

For the POST /tasks handler:
```typescript
// BEFORE:
app.post(
  "/tasks",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error, request: _request }: any) => {
    const authCtx = store.authContext!;
    const payload = body as CreateTaskRequest;
    ...

// AFTER:
app.post(
  "/tasks",
  async ({ authContext, body, error }) => {
    const payload = body as CreateTaskRequest;
    ...
```

Note: `body as CreateTaskRequest` may still be needed if Elysia's `.model()` registration doesn't fully narrow the body type in this version. If `body: "create-task-request"` in the route options makes Elysia infer `body` as `CreateTaskRequest`, then the cast can be removed. Test this by removing the cast and running `bun run typecheck`. If it fails, keep the cast.

Apply the same pattern to all 9 handlers:
- GET /tasks
- POST /tasks
- GET /tasks/:id
- PUT /tasks/:id
- DELETE /tasks/:id
- POST /tasks/:id/toggle
- POST /tasks/:id/trigger
- GET /tasks/:id/logs
- DELETE /tasks/:id/logs

- [ ] **Step 2: Verify tasks.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "tasks.ts" || echo "No errors in tasks.ts"
```

#### Task 3b: Migrate `src/routes/web/organizations.ts`

**Files:**
- Modify: `src/routes/web/organizations.ts`

- [ ] **Step 1: Replace 2 handler signatures**

For the POST /organizations handler:
```typescript
// BEFORE:
async ({ store, body, error, request }: any) => {
  const b = body ?? {};
  ...
  const authCtx = store.authContext;
  ...

// AFTER:
async ({ authContext, body, error, request }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  ...
  // Replace store.authContext with authContext where used
  ...
```

For the POST /apiKeys handler:
```typescript
// BEFORE:
async ({ store: _store, body, error, request }: any) => {
  const b = body ?? {};
  ...

// AFTER:
async ({ body, error, request }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  ...
```

Note: The organizations.ts handlers use a dynamic action-dispatch pattern (`body.action`) without a registered body model, so `body` will be typed as `unknown`. Use `const b = (body ?? {}) as Record<string, unknown>` to maintain type safety for the action dispatch pattern.

- [ ] **Step 2: Verify organizations.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "organizations.ts" || echo "No errors in organizations.ts"
```

#### Task 3c: Migrate `src/routes/web/instances.ts`

**Files:**
- Modify: `src/routes/web/instances.ts`

- [ ] **Step 1: Replace 2 handler signatures**

For POST /instances/from-environment:
```typescript
// BEFORE:
async ({ store, body, error }: any) => {
  const user = store.user!;
  const authCtx = store.authContext!;
  const b = body as { environmentId: string };
  ...

// AFTER:
async ({ user, authContext, body, error }) => {
  const b = body as { environmentId: string };
  ...use authContext instead of authCtx...
  ...use user instead of store.user!...
```

For GET /instances:
```typescript
// BEFORE:
async ({ store, request: _request }: any) => {
  const authCtx = store.authContext!;
  ...

// AFTER:
async ({ authContext }) => {
  ...use authContext instead of authCtx...
```

For DELETE /instances/:id (already uses inline types without `: any`):
```typescript
// BEFORE:
async ({ store, params, error, request: _request }) => {
  const _user = store.user!;
  const authCtx = store.authContext!;
  ...

// AFTER:
async ({ user, authContext, params, error }) => {
  ...use authContext instead of authCtx, user instead of _user...
```

- [ ] **Step 2: Verify instances.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "instances.ts" || echo "No errors in instances.ts"
```

#### Task 3d: Migrate `src/routes/web/knowledge-bases.ts`

**Files:**
- Modify: `src/routes/web/knowledge-bases.ts`

- [ ] **Step 1: Replace 8 handler signatures**

Apply the same pattern to all handlers:
- Remove `: any` and `biome-ignore` comments
- Replace `store.authContext!` with `authContext`
- Replace `body as { ... }` casts -- keep if Elysia doesn't infer model types
- The file upload handler (`/knowledgeBases/:id/resources/upload`) already doesn't use `: any` -- just replace `store.authContext!` with `authContext`

```typescript
// Example for GET /knowledgeBases:
// BEFORE:
async ({ store }: any) => {
  const authCtx = store.authContext!;
  ...
// AFTER:
async ({ authContext }) => {
  ...
```

```typescript
// Example for POST /knowledgeBases:
// BEFORE:
async ({ store, body, error }: any) => {
  const authCtx = store.authContext!;
  const payload = body as { name: string; slug: string; description?: string };
  ...
// AFTER:
async ({ authContext, body, error }) => {
  const payload = body as { name: string; slug: string; description?: string };
  ...
```

- [ ] **Step 2: Verify knowledge-bases.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "knowledge-bases.ts" || echo "No errors in knowledge-bases.ts"
```

#### Task 3e: Migrate `src/routes/web/workflow-defs.ts`

**Files:**
- Modify: `src/routes/web/workflow-defs.ts`

- [ ] **Step 1: Replace the single handler signature**

```typescript
// BEFORE:
async ({ store, body, error }: any) => {
  const authCtx = store.authContext!;
  const payload = body as Record<string, unknown>;
  ...

// AFTER:
async ({ authContext, body, error }) => {
  const payload = body as Record<string, unknown>;
  ...replace all authCtx references with authContext...
```

- [ ] **Step 2: Verify workflow-defs.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "workflow-defs.ts" || echo "No errors in workflow-defs.ts"
```

#### Task 3f: Migrate `src/routes/web/workflow-engine.ts`

**Files:**
- Modify: `src/routes/web/workflow-engine.ts`

- [ ] **Step 1: Replace the single handler signature**

```typescript
// BEFORE:
async ({ store, body, error }: any) => {
  const authCtx = store.authContext!;
  const payload = body as Record<string, unknown>;
  ...

// AFTER:
async ({ authContext, body, error }) => {
  const payload = body as Record<string, unknown>;
  ...replace all authCtx references with authContext...
```

- [ ] **Step 2: Verify workflow-engine.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "workflow-engine.ts" || echo "No errors in workflow-engine.ts"
```

#### Task 3g: Migrate `src/routes/web/meta-agent.ts`

**Files:**
- Modify: `src/routes/web/meta-agent.ts`

- [ ] **Step 1: Replace the single handler signature**

```typescript
// BEFORE:
async ({ store, request, error }: any) => {
  const authCtx = store.authContext!;
  if (!authCtx) {
    return error(401, ...);
  }
  ...

// AFTER:
async ({ authContext, request, error }) => {
  // authContext is now always non-null when sessionAuth: true
  // Remove the null check since resolve guarantees non-null
  ...
```

- [ ] **Step 2: Verify meta-agent.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "meta-agent.ts" || echo "No errors in meta-agent.ts"
```

#### Task 3h: Migrate config route files

**Files:**
- Modify: `src/routes/web/config/providers.ts`
- Modify: `src/routes/web/config/agents.ts`
- Modify: `src/routes/web/config/skills.ts`
- Modify: `src/routes/web/config/models.ts`
- Modify: `src/routes/web/config/mcp.ts`

All config route files follow the same pattern: a single POST handler with action dispatch. The extracted handler functions (`handleList`, `handleGet`, etc.) take `AuthContext` as a parameter -- these do NOT need to change since `AuthContext` is already a proper type. Only the inline POST handler signatures need updating.

- [ ] **Step 1: Update each config file's POST handler**

For each file (providers.ts, agents.ts, skills.ts, models.ts, mcp.ts), make these changes:

```typescript
// BEFORE (providers.ts example):
app.post(
  "/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + dynamic action body
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = body as ProviderBody;
    ...

// AFTER:
app.post(
  "/providers",
  async ({ authContext, body, error }) => {
    const b = body as ProviderBody;
    ...replace authCtx with authContext...
```

Same pattern for agents.ts, skills.ts (2 handlers), models.ts, mcp.ts.

- [ ] **Step 2: Verify all config files compile**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "config/" || echo "No errors in config route files"
```

---

### Task 4: Migrate Pattern A route files (remove `!` and `?.`)

These files already work without `: any` but use `store.authContext!` (non-null assertion) or `store.authContext?.` (optional chaining). After Task 1, these handlers will receive `authContext` as a top-level context property.

#### Task 4a: Migrate `src/routes/web/environments.ts`

**Files:**
- Modify: `src/routes/web/environments.ts`

- [ ] **Step 1: Replace `store.authContext!` with `authContext` and `store.user!` with `user` in all 7 handlers**

```typescript
// BEFORE:
async ({ store }) => {
  const authCtx = store.authContext!;
  return listEnvironmentsWithInstances(authCtx.organizationId);
}

// AFTER:
async ({ authContext }) => {
  return listEnvironmentsWithInstances(authContext.organizationId);
}
```

For handlers that use both `store.user!` and `store.authContext!`:
```typescript
// BEFORE:
async ({ store, body, error }) => {
  const user = store.user!;
  const authCtx = store.authContext!;
  ...

// AFTER:
async ({ user, authContext, body, error }) => {
  ...
```

Apply to all 7 handlers: GET /environments, POST /environments, GET /environments/:id, PUT /environments/:id, POST /environments/:id/enter, GET /environments/:id/instances, DELETE /environments/:id.

- [ ] **Step 2: Verify environments.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "environments.ts" || echo "No errors in environments.ts"
```

#### Task 4b: Migrate `src/routes/web/sessions.ts`

**Files:**
- Modify: `src/routes/web/sessions.ts`

- [ ] **Step 1: Replace `store.authContext!` with `authContext` in 3 handlers**

```typescript
// BEFORE:
async ({ store, request: _request }) => {
  const authCtx = store.authContext!;
  ...

// AFTER:
async ({ authContext }) => {
  ...replace authCtx with authContext...
```

Apply to: GET /sessions, GET /sessions/:id, GET /sessions/:id/history.

- [ ] **Step 2: Verify sessions.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "sessions" | grep -v "__tests__" || echo "No errors in sessions.ts"
```

#### Task 4c: Migrate `src/routes/web/files.ts`

**Files:**
- Modify: `src/routes/web/files.ts`

- [ ] **Step 1: Replace `store.authContext!` with `authContext` and `(params as any)` with typed access in 5 handlers**

For the `(params as any)["*"]` pattern (splat route parameter), replace with a local type assertion:
```typescript
// BEFORE:
const filePath = normalizeUserRoutePath((params as any)["*"] as string);

// AFTER:
const filePath = normalizeUserRoutePath((params as Record<string, string>)["*"]);
```

For `store.authContext!`:
```typescript
// BEFORE:
const authCtx = store.authContext!;
await requireEnv(envId, authCtx.organizationId, error);

// AFTER:
await requireEnv(envId, authContext.organizationId, error);
```

Apply to all 5 handlers: GET /:id/user, GET /:id/user/*, POST /:id/user/*, PUT /:id/user/*, DELETE /:id/user/*.

- [ ] **Step 2: Verify files.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "files.ts" || echo "No errors in files.ts"
```

#### Task 4d: Migrate `src/routes/web/channels.ts`

**Files:**
- Modify: `src/routes/web/channels.ts`

- [ ] **Step 1: Replace `store.authContext!` with `authContext` in 4 handlers**

Apply to: GET /channels/bindings, POST /channels/bindings, DELETE /channels/bindings/:id, PATCH /channels/bindings/:id.

- [ ] **Step 2: Verify channels.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "channels.ts" || echo "No errors in channels.ts"
```

#### Task 4e: Migrate `src/routes/web/control.ts`

**Files:**
- Modify: `src/routes/web/control.ts`

- [ ] **Step 1: Replace `store.authContext?.` optional chaining with `authContext.` in 3 handlers**

```typescript
// BEFORE:
const userId = store.user?.id ?? null;
const orgId = store.authContext?.organizationId ?? null;

// AFTER:
const userId = user.id;
const orgId = authContext.organizationId;
```

Apply to: POST /sessions/:id/events, POST /sessions/:id/control, POST /sessions/:id/interrupt.

- [ ] **Step 2: Verify control.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "control.ts" || echo "No errors in control.ts"
```

#### Task 4f: Migrate `src/routes/web/s3-files.ts`

**Files:**
- Modify: `src/routes/web/s3-files.ts`

- [ ] **Step 1: Replace `store.authContext?.organizationId` with `authContext.organizationId` in 5 handlers**

```typescript
// BEFORE:
const orgId = store.authContext?.organizationId;
if (!orgId) return error(403, ...);

// AFTER:
const orgId = authContext.organizationId;
// Remove the null check since authContext is guaranteed non-null
```

Apply to: GET /files, GET /files/presign, POST /files/presign, POST /files/upload, DELETE /files.

- [ ] **Step 2: Verify s3-files.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "s3-files.ts" || echo "No errors in s3-files.ts"
```

#### Task 4g: Migrate `src/routes/web/user-file.ts`

**Files:**
- Modify: `src/routes/web/user-file.ts`

- [ ] **Step 1: Replace `store.authContext!` with `authContext` in 4 handlers**

Apply to: GET /:id/user-file/tree, POST /:id/user-file/rename, POST /:id/user-file/mkdir, DELETE /:id/user-file/batch.

- [ ] **Step 2: Verify user-file.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -i "user-file.ts" || echo "No errors in user-file.ts"
```

#### Task 4h: Migrate `src/routes/web/auth.ts`

**Files:**
- Modify: `src/routes/web/auth.ts`

- [ ] **Step 1: Replace nullable `store.authContext` access with `authContext` in 1 handler**

```typescript
// BEFORE:
const user = store.user;
if (!user) {
  return error(401, ...);
}
...
const authCtx = store.authContext;
if (!authCtx) {
  return error(403, ...);
}

// AFTER:
// user and authContext are both guaranteed non-null by sessionAuth: true resolve
const resolvedSessionId = await resolveExistingSessionId(sessionId);
...
```

- [ ] **Step 2: Verify auth.ts compiles**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep "routes/web/auth.ts" || echo "No errors in auth.ts"
```

---

### Task 5: Run full test suite and fix any regressions

**Files:**
- Potentially modify: any failing test file

The `resolve` pattern change in `authGuardPlugin` may affect test behavior since `setTestAuth` now needs to work with the `resolve` return path instead of `beforeHandle` + store mutation. The test injection mechanism was preserved in Task 1 (the resolve function checks `_testAuth` first), but runtime behavior may differ slightly.

- [ ] **Step 1: Run all backend tests**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/ 2>&1 | tail -30
```

- [ ] **Step 2: If any config-related tests fail, debug the resolve vs beforeHandle timing difference**

The key difference: `resolve` runs at `beforeHandle` lifecycle (after validation), same timing as `beforeHandle`. The test auth injection should work identically. If tests fail, check:
1. Does the test create an Elysia app with `authGuardPlugin` and call `.handle()` with mock requests?
2. Does the test mock `auth.api.getSession`? The resolve path calls the same function.
3. Does the test expect `store.authContext` to be set? We still mutate store in the resolve body.

If the resolve function returns a `Response` (error case), Elysia short-circuits. This is the same as the old `beforeHandle` returning a value.

- [ ] **Step 3: Run typecheck + lint to confirm zero errors**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

---

### Task 6: Final cleanup and verification

**Files:**
- Potentially modify: any file with remaining `as any` in route handlers

- [ ] **Step 1: Count remaining `as any` in route files**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && grep -rn "as any" src/routes/web/ | grep -v "node_modules"
```

Expected: 0 `as any` casts (except `(params as Record<string, string>)["*"]` for splat params if Elysia doesn't type them).

- [ ] **Step 2: Count remaining `biome-ignore` suppressions in route files**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && grep -rn "biome-ignore lint/suspicious/noExplicitAny" src/routes/web/
```

Expected: 0 suppressions.

- [ ] **Step 3: Count remaining `: any` in route handler signatures**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && grep -rn ": any" src/routes/web/ | grep -v "as any" | grep -v "biome-ignore"
```

Expected: 0 `: any` annotations.

- [ ] **Step 4: Run the full precheck suite**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

This runs both TypeScript type checking (backend + frontend) and Biome lint. Must pass with 0 errors.

- [ ] **Step 5: Run all tests**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/
```

All tests must pass.

---

## Risks and Mitigations

### Risk 1: Elysia `resolve` return type inference doesn't work with Elysia 1.4.x
**Mitigation**: The Elysia docs (version matching 1.2.10+) explicitly show the `resolve` pattern with full type inference. The macro property shorthand (`{ resolve: () => ({ ... }) }`) is the recommended approach. If inference doesn't work, we can try the named macro pattern: `.macro('sessionAuth', { resolve: ... })`.

### Risk 2: `body` type inference from `.model()` may not work
**Mitigation**: Some routes may still need `body as SomeType` casts. This is acceptable -- the plan focuses on eliminating `: any` handler signatures and `store.authContext!` assertions, not every single type cast. Body type inference from models is a separate Elysia concern.

### Risk 3: `resolve` returning `Response` for error cases may behave differently than `beforeHandle` returning `Response`
**Mitigation**: Per Elysia docs, `resolve` (which runs at `beforeHandle` lifecycle) supports returning early responses identically to `beforeHandle`. The test suite will validate this.

### Risk 4: Splat route params (`params["*"]`) may not be typed by Elysia
**Mitigation**: Use `(params as Record<string, string>)["*"]` instead of `(params as any)["*"]`. This is more type-safe while still handling Elysia's limitation with splat param typing.

### Risk 5: The `store` mutation inside `resolve` may cause issues if Elysia freezes the store object
**Mitigation**: Elysia state is mutable by design. The store mutation is kept as a backward-compatible runtime side effect. If it causes issues, the store mutation can be removed since all handlers now read from the resolved context properties.

## Summary of Expected Improvements

| Metric | Before | After |
|--------|--------|-------|
| Handler `: any` annotations | 30 | 0 |
| `as any` casts in route files | 47 | ~6 (splat params only) |
| `biome-ignore noExplicitAny` suppressions | 15 | 0 |
| `store.authContext!` non-null assertions | ~50 | 0 |
| `store.user!` non-null assertions | ~8 | 0 |
| `store.authContext?.` optional chaining | ~10 | 0 |
| `body as SomeType` casts | 28 | ~28 (Elysia model limitation) |
