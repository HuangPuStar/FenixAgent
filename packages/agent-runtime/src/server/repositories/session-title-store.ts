import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionTitleStore } from "@fenix/chat-channel/server";
import { z } from "zod/v4";

const TITLE_RECORD_SCHEMA = z.object({
  sessionId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
});

function identifierHash(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Fenix-owned 会话标题文件仓库，位于 workspace 根下的独立平台目录，不进入 Agent 工作目录。
 * 每个 ACP 会话单独原子替换，避免并发更新其他会话时丢失数据；部署须持久挂载 workspace 根。
 */
export function createFileSessionTitleStore(workspaceRoot: () => string): SessionTitleStore {
  const directory = (rcsSessionId: string) =>
    join(workspaceRoot(), ".fenix-session-titles", identifierHash(rcsSessionId));
  const filename = (sessionId: string) => `${identifierHash(sessionId)}.json`;

  return {
    async read(rcsSessionId) {
      const sessionDirectory = directory(rcsSessionId);
      let entries: string[];
      try {
        entries = await readdir(sessionDirectory);
      } catch (error) {
        if (isMissing(error)) return {};
        throw error;
      }
      const titles: Record<string, string> = Object.create(null);
      for (const entry of entries) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        let content: string;
        try {
          content = await readFile(join(sessionDirectory, entry), "utf8");
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        const record = TITLE_RECORD_SCHEMA.parse(JSON.parse(content));
        if (filename(record.sessionId) !== entry) throw new Error("Invalid session title record identifier");
        titles[record.sessionId] = record.title;
      }
      return titles;
    },
    async write(rcsSessionId, sessionId, title) {
      const record = TITLE_RECORD_SCHEMA.parse({ sessionId, title });
      const sessionDirectory = directory(rcsSessionId);
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      const temporary = join(sessionDirectory, `.tmp-${crypto.randomUUID()}`);
      try {
        await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
        await rename(temporary, join(sessionDirectory, filename(sessionId)));
      } catch (error) {
        try {
          await unlink(temporary);
        } catch (cleanupError) {
          if (!isMissing(cleanupError)) {
            throw new AggregateError([error, cleanupError], "Session title write and cleanup failed");
          }
        }
        throw error;
      }
    },
    async delete(rcsSessionId, sessionId) {
      try {
        await unlink(join(directory(rcsSessionId), filename(sessionId)));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}
