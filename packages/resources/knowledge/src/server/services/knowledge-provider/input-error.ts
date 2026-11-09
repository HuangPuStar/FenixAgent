/** Provider 在发出远端请求前识别的输入错误，由应用边界映射为参数校验失败。 */
export class KnowledgeProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeProviderValidationError";
  }
}
