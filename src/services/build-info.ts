/** 通过 git 命令获取 commit，只在本地调试的时候有用，正式环境中没有 .git 目录和 git 命令。 */
function readGitCommitFromProcess(): string | undefined {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });

    if (result.exitCode !== 0) return undefined;

    const commitId = new TextDecoder().decode(result.stdout).trim();
    return commitId ? commitId : undefined;
  } catch {
    return undefined;
  }
}

/** 获取 commit，优先使用 GIT_COMMIT_SHA 变量，本地调试没有 GIT_COMMIT_SHA 时使用 git 命令获取。 */
export function resolveCommitId(
  injectedCommitId: string | undefined,
  readGitCommit: () => string | undefined = readGitCommitFromProcess,
): string {
  const normalizedInjectedCommitId = injectedCommitId?.trim();
  if (normalizedInjectedCommitId && normalizedInjectedCommitId !== "unknown") {
    return normalizedInjectedCommitId;
  }

  return readGitCommit() ?? "unknown";
}

const injectedCommitId = process.env.GIT_COMMIT_SHA;

/** 服务版本信息。 */
export const buildInfo = {
  commitId: resolveCommitId(injectedCommitId),
};

/** 构造公开健康检查返回值，启动时间由进程启动时固定记录。 */
export function buildHealthInfo(startedAt: string) {
  return {
    status: "ok" as const,
    commitId: buildInfo.commitId,
    startedAt,
  };
}
