import { beforeEach, describe, expect, test } from "bun:test";

import { issueToken, resolveToken } from "../auth/token";
import { resetAllRepos } from "../repositories";

// ---------- token ----------

describe("issueToken / resolveToken", () => {
  beforeEach(() => {
    resetAllRepos();
  });

  test("issues and resolves a token", async () => {
    const { token, expires_in } = await issueToken("alice");
    expect(token).toMatch(/^rct_\d+_[0-9a-f]+$/);
    expect(expires_in).toBe(86400);
    expect(await resolveToken(token)).toBe("alice");
  });

  test("returns null for unknown token", async () => {
    expect(await resolveToken("nonexistent")).toBeNull();
  });

  test("returns null for undefined token", async () => {
    expect(await resolveToken(undefined)).toBeNull();
  });

  test("tokens are unique", async () => {
    const t1 = (await issueToken("alice")).token;
    const t2 = (await issueToken("alice")).token;
    expect(t1).not.toBe(t2);
  });
});
