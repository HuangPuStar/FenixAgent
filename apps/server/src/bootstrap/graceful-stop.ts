/** 停止接收新请求；超时只报告，由调用方完成宿主清理后退出，避免重复调用 stop hook。 */
export async function stopAcceptingRequests(options: {
  readonly stop: () => Promise<void>;
  readonly graceMs: number;
  readonly onTimeout: () => void;
}): Promise<"completed" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopError: unknown;
  const draining = Promise.resolve()
    .then(() => options.stop())
    .catch((error: unknown) => {
      stopError = error;
    });
  const completed = await Promise.race([
    draining.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), options.graceMs);
    }),
  ]);
  clearTimeout(timer);
  if (completed) {
    if (stopError) throw stopError;
    return "completed";
  }
  options.onTimeout();
  return "timeout";
}
