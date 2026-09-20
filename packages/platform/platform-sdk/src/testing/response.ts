/** 路由响应的运行时 JSON 值；不引入协议类型，避免测试被路由声明中的窄响应类型限制。 */
export type ResponseJson = ReturnType<typeof JSON.parse>;

/** 以运行时 JSON 值读取路由响应，供 route 级用例断言响应体。 */
export async function readJson(response: Response): Promise<ResponseJson> {
  return response.json();
}
