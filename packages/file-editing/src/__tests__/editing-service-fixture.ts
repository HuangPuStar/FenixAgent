import { afterEach, expect } from "bun:test";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { EditingError, type EditingFileAccess, type EditingScope, type OfficeSession } from "../../contracts";
import { createEditingService } from "../server";

export const secret = "test-only-office-signing-secret";
export const scope: EditingScope = { organizationId: "org", userId: "user", environmentId: "env" };
export const services: ReturnType<typeof createEditingService>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

export function setup(policy = {}) {
  let bytes = new TextEncoder().encode("original");
  let authorized = true;
  let commandError = 0;
  let output = new TextEncoder().encode("edited");
  let downloadResponse: (() => Response) | undefined;
  let now = Date.now();
  const uploads: { expectedVersion: string; opId: string }[] = [];
  const commands: Record<string, unknown>[] = [];
  const version = () => createHash("sha256").update(bytes).digest("hex");
  const auth = () => {
    if (!authorized) throw new EditingError("forbidden", "Access revoked");
  };
  const files: EditingFileAccess = {
    async authorize() {
      auth();
    },
    async stat() {
      auth();
      return { size: bytes.length, version: version(), isDirectory: false };
    },
    async readSnapshot(_scope, path) {
      auth();
      return {
        path,
        size: bytes.length,
        version: version(),
        bytes: bytes.slice(),
        mimeType: "application/octet-stream",
      };
    },
    async upload(_scope, path, next, options) {
      auth();
      if (options.expectedVersion !== version()) throw new EditingError("conflict", "Changed");
      uploads.push({ expectedVersion: options.expectedVersion, opId: options.opId });
      bytes = next.slice();
      return { path, size: bytes.length, version: version() };
    },
  };
  const service = createEditingService({
    config: { publicUrl: "https://docs.example/", baseUrl: "https://app.example/", jwtSecret: secret },
    files,
    policy,
    now: () => now,
    fetch: async (_url, options) => {
      if (options?.method === "POST") {
        commands.push(JSON.parse(String(options.body)));
        return Response.json({ error: commandError });
      }
      expect(options?.redirect).toBe("error");
      return downloadResponse?.() ?? new Response(output);
    },
  });
  services.push(service);
  return {
    service,
    files,
    uploads,
    commands,
    content: () => new TextDecoder().decode(bytes),
    change: (value: string) => {
      bytes = new TextEncoder().encode(value);
    },
    revoke: () => {
      authorized = false;
    },
    setCommandError: (value: number) => {
      commandError = value;
    },
    setOutput: (value: string) => {
      output = new TextEncoder().encode(value);
    },
    setResponse: (factory: () => Response) => {
      downloadResponse = factory;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

export function urls(session: OfficeSession) {
  const config = session.initialization.config as {
    document: { key: string; url: string };
    editorConfig: { callbackUrl: string };
  };
  return {
    key: config.document.key,
    document: config.document.url.split("/").pop() ?? "",
    callback: config.editorConfig.callbackUrl.split("/").pop() ?? "",
  };
}
export async function signed(fields: Record<string, unknown>) {
  return {
    token: await new SignJWT(fields).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret)),
  };
}
export async function saveCallback(
  fixture: ReturnType<typeof setup>,
  session: OfficeSession,
  saveId: string,
  fields = {},
) {
  const target = urls(session);
  return fixture.service.callback(
    target.callback,
    await signed({
      key: target.key,
      status: 6,
      userdata: saveId,
      filetype: "docx",
      url: "https://docs.example/cache/result.docx",
      ...fields,
    }),
  );
}
