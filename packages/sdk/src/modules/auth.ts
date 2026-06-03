import { BaseApi } from "../base";
import type { ApiResult } from "../result";

export class AuthApi extends BaseApi {
  async bind(body?: { sessionId?: string; uuid?: string }): Promise<ApiResult<{ ok: boolean; sessionId: string }>> {
    return this.post("/web/bind", body);
  }

  async changePassword(
    body: { oldPassword: string; newPassword: string },
  ): Promise<ApiResult<{ success: boolean; data: { userId: string } }>> {
    return this.post("/web/change-password", body);
  }
}
