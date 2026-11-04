/** Preserve upstream status for domain decisions without parsing error messages. */
export class KnowledgeProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeProviderHttpError";
  }
}
