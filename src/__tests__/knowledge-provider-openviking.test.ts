import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";

setConfig({
  knowledgeApiKey: "test-key",
  knowledgeBaseUrl: "http://openviking.test",
  knowledgeRequestTimeoutMs: 15000,
});

const { OpenVikingKnowledgeProvider } = await import("../services/knowledge-provider/openviking");

const originalFetch = globalThis.fetch;

describe("OpenVikingKnowledgeProvider", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    setConfig({
      knowledgeApiKey: "test-key",
      knowledgeBaseUrl: "http://openviking.test",
      knowledgeRequestTimeoutMs: 15000,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetConfig();
  });

  test("createKnowledgeBase stays local and leaves remoteId empty until first resource", async () => {
    const fetchSpy = mock(async () => new Response());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const provider = new OpenVikingKnowledgeProvider();
    const result = await provider.createKnowledgeBase({
      userId: "kb-user-1",
      slug: "project-docs",
      name: "Project Docs",
    });

    expect(result.remoteId).toBeNull();
    expect(result.status).toBe("empty");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("addResource uploads file to a stable target uri under the knowledge-base path", async () => {
    const fetchSpy = mock(async (url: string) => {
      if (url.endsWith("/api/v1/resources/temp_upload")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: { temp_file_id: "tmp_123" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          status: "ok",
          result: {
            status: "success",
            root_uri: "viking://resources/kb/kb-user-1/project-docs/guide.md",
            source_path: "/tmp/guide.md",
            errors: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new OpenVikingKnowledgeProvider();
    const result = await provider.addResource({
      knowledgeBaseRemoteId: "viking://resources/kb/kb-user-1/project-docs/",
      targetRemoteId: "viking://resources/kb/kb-user-1/project-docs/guide.md",
      remoteAccountId: "acct-user-1",
      remoteUserId: "kb-user-1",
      filePath: "/tmp/guide.md",
      sourceName: "guide.md",
    });

    expect(result.remoteId).toBe("viking://resources/kb/kb-user-1/project-docs/guide.md");
    expect(result.knowledgeBaseRemoteId).toBe("viking://resources/kb/kb-user-1/project-docs/");
    expect(result.status).toBe("ready");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const addResourceCall = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    expect(addResourceCall[0]).toBe("http://openviking.test/api/v1/resources");
    expect((addResourceCall[1].headers as Headers).get("X-API-Key")).toBe("test-key");
    expect((addResourceCall[1].headers as Headers).get("X-OpenViking-Account")).toBe("acct-user-1");
    expect((addResourceCall[1].headers as Headers).get("X-OpenViking-User")).toBe("kb-user-1");
    expect(JSON.parse(String(addResourceCall[1].body))).toMatchObject({
      to: "viking://resources/kb/kb-user-1/project-docs/guide.md",
    });
  });

  test("search queries /api/v1/search/search per knowledge-base uri and normalizes results", async () => {
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          status: "ok",
          result: {
            resources: [
              {
                uri: `${body.target_uri}spec-design.md`,
                content: `${body.query} snippet`,
                score: body.target_uri.includes("docs-a") ? 0.92 : 0.88,
              },
            ],
            total: 1,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenVikingKnowledgeProvider();
    const result = await provider.search({
      knowledgeBases: [
        {
          remoteId: "viking://resources/kb/kb-user-1/docs-a/",
          remoteAccountId: "acct-a",
          remoteUserId: "kb-user-1",
        },
        {
          remoteId: "viking://resources/kb/kb-user-1/docs-b/",
          remoteAccountId: "acct-b",
          remoteUserId: "kb-user-1",
        },
      ],
      query: "api",
      topK: 5,
    });

    expect(result).toEqual([
      {
        title: "spec-design.md",
        snippet: "api snippet",
        source: "viking://resources/kb/kb-user-1/docs-a/spec-design.md",
        score: 0.92,
        knowledgeBaseId: "viking://resources/kb/kb-user-1/docs-a/",
        resourceId: "viking://resources/kb/kb-user-1/docs-a/spec-design.md",
      },
      {
        title: "spec-design.md",
        snippet: "api snippet",
        source: "viking://resources/kb/kb-user-1/docs-b/spec-design.md",
        score: 0.88,
        knowledgeBaseId: "viking://resources/kb/kb-user-1/docs-b/",
        resourceId: "viking://resources/kb/kb-user-1/docs-b/spec-design.md",
      },
    ]);
  });

  test("readResource uses /api/v1/content/read", async () => {
    const fetchSpy = mock(
      async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            result: "# Guide",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new OpenVikingKnowledgeProvider();
    const result = await provider.readResource({
      resourceRemoteId: "viking://resources/kb/kb-user-1/docs-a/guide.md",
      remoteAccountId: "acct-user-1",
      remoteUserId: "kb-user-1",
    });

    expect(result).toEqual({
      resourceId: "viking://resources/kb/kb-user-1/docs-a/guide.md",
      title: "guide.md",
      content: "# Guide",
      source: "viking://resources/kb/kb-user-1/docs-a/guide.md",
    });
    const readCall = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(readCall[0]).toContain("/api/v1/content/read?uri=");
    expect((readCall[1].headers as Headers).get("X-OpenViking-User")).toBe("kb-user-1");
  });
});
