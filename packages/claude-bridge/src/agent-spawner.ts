import { type Query, query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude Code CLI 子进程 spawner。
 * 使用 claude-agent-sdk 的 query() 管理子进程生命周期和流式输出。
 */
export class ClaudeAgentSpawner {
  private currentQuery: Query | null = null;
  private abortController: AbortController | null = null;

  spawn(options: {
    cwd: string;
    prompt: string;
    model?: string;
    systemPrompt?: string;
    permissionMode?: string;
    allowedTools?: string[];
    mcpServers?: Record<string, unknown>;
    maxTurns?: number;
    cliPath?: string;
  }): Query {
    this.abortController = new AbortController();

    this.currentQuery = query({
      prompt: options.prompt,
      options: {
        model: options.model ?? "claude-sonnet-4-6",
        systemPrompt: options.systemPrompt,
        permissionMode: (options.permissionMode ?? "default") as
          | "default"
          | "acceptEdits"
          | "bypassPermissions"
          | "plan"
          | "dontAsk",
        allowedTools: options.allowedTools ?? [],
        mcpServers:
          (options.mcpServers as Record<
            string,
            { command: string; args?: string[]; env?: Record<string, string> } | { type: "sse"; url: string }
          >) ?? {},
        cwd: options.cwd,
        maxTurns: options.maxTurns ?? 200,
        pathToClaudeCodeExecutable: options.cliPath ?? process.env.CLAUDE_CODE_CLI_PATH,
        abortController: this.abortController,
      },
    });

    return this.currentQuery;
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.currentQuery = null;
  }

  getAbortController(): AbortController | null {
    return this.abortController;
  }
}
