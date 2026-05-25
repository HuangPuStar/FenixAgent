import { BaseApi } from "../base";
import type { ApiResult } from "../result";

export class MetaAgentApi extends BaseApi {
  async ensure(): Promise<ApiResult<{ id: string; name: string }>> {
    return this.post("/web/meta-agent/ensure");
  }
}
