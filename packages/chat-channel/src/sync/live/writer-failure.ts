/** 补充恢复失败的诊断原因，同时保留首次停写错误的身份与协议码。 */
export function retainWriterFailure(error: unknown, recoveryError: unknown): unknown {
  if (!(error instanceof Error))
    return new AggregateError([error, recoveryError], "live writer cursor recovery failed");
  const causes = error.cause === undefined ? [recoveryError] : [error.cause, recoveryError];
  error.cause = new AggregateError(causes, "live writer cursor recovery failed");
  return error;
}
