import { describe, expect, it, mock } from "bun:test";

// mock logger
mock.module("../logger", () => ({
  log: mock(() => {}),
  error: mock(() => {}),
}));

// mock errors
class ConflictError extends Error { code = "ALREADY_EXISTS"; statusCode = 409; constructor(m: string) { super(m); this.name = "ConflictError"; } }
class ValidationError extends Error { code = "VALIDATION_ERROR"; statusCode = 400; constructor(m: string) { super(m); this.name = "ValidationError"; } }
mock.module("../errors", () => ({
  ValidationError,
  ConflictError,
  ConfigWriteError: class extends Error { code = "CONFIG_WRITE_ERROR"; statusCode = 500; constructor(m: string) { super(m); } },
  NotFoundError: class extends Error { code = "NOT_FOUND"; statusCode = 404; constructor(m: string) { super(m); } },
}));

// mock config-pg
mock.module("../services/config-pg", () => ({
  getAgentConfigById: mock(() => Promise.resolve(null)),
}));

// mock instance
mock.module("../services/instance", () => ({
  groupActiveInstancesByEnvironment: mock(() => new Map()),
}));

// mock environment-core
const mockValidateWorkspacePath = mock(() => null);
const mockEnsureWorkspaceDir = mock(() => "/tmp/workspace");
const mockGenerateEnvSecret = mock(() => "env_secret_test");
const mockGetOwnedEnvironment = mock(() => Promise.resolve({ id: "env-1", userId: "user-1" }));
mock.module("../services/environment-core", () => ({
  validateWorkspacePath: mockValidateWorkspacePath,
  ensureWorkspaceDir: mockEnsureWorkspaceDir,
  KEBAB_CASE_RE: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
  generateEnvSecret: mockGenerateEnvSecret,
  sanitizeResponse: mock(() => ({})),
  getOwnedEnvironment: mockGetOwnedEnvironment,
  deleteEnvironment: mock(() => Promise.resolve(true)),
}));

// mock repositories
const mockCreate = mock(() => Promise.resolve({ id: "env-new" }));
const mockUpdate = mock(() => Promise.resolve(true));
const mockGetById = mock(() => Promise.resolve({ id: "env-1", userId: "user-1", name: "test" }));
mock.module("../repositories", () => ({
  environmentRepo: {
    create: mockCreate,
    update: mockUpdate,
    getById: mockGetById,
    listByUserId: mock(() => Promise.resolve([])),
  },
}));

const { createWebEnvironment } = await import("../services/environment-web");

describe("createWebEnvironment duplicate detection", () => {
  it("PG unique violation → ConflictError", async () => {
    const pgError = new Error('duplicate key value violates unique constraint "environment_name_unique"');
    mockCreate.mockImplementationOnce(() => { throw pgError; });
    mockValidateWorkspacePath.mockImplementation(() => null);
    mockEnsureWorkspaceDir.mockImplementation(() => "/tmp/ws");

    await expect(createWebEnvironment({
      name: "test-env",
      workspacePath: "/tmp/ws",
      userId: "user-1",
    })).rejects.toThrow(ConflictError);
  });

  it("PG UNIQUE constraint error → ConflictError", async () => {
    const pgError = new Error('UNIQUE constraint failed: environment.name');
    mockCreate.mockImplementationOnce(() => { throw pgError; });

    await expect(createWebEnvironment({
      name: "test-env2",
      workspacePath: "/tmp/ws",
      userId: "user-1",
    })).rejects.toThrow(ConflictError);
  });

  it("非 unique 错误原样抛出", async () => {
    const otherError = new Error("connection refused");
    mockCreate.mockImplementationOnce(() => { throw otherError; });

    await expect(createWebEnvironment({
      name: "test-env3",
      workspacePath: "/tmp/ws",
      userId: "user-1",
    })).rejects.toThrow("connection refused");
  });
});
