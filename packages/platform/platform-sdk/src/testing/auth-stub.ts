/**
 * 身份认证入口的替身注册表（`auth.api` 方法名 → 替身函数，以及 better-auth handler）。
 *
 * 为什么放在契约包而不是 `@fenix/identity`：identity 是纯库，不得持有进程级可变测试状态，否则同进程内
 * 两次装配会共享它；而宿主 preload（替换 better-auth 模块）与各包的路由用例必须写入**同一份**注册表，
 * 否则用例登记的会话在宿主注入的认证守卫里读不到。
 *
 * 键清单必须与 `auth.api` 的真实方法逐一对应：preload 是整体替换该模块，清单缺少某个真实方法会让导入方
 * 拿到 `undefined` 而不是明确的「未登记」错误。
 */

// biome-ignore lint/suspicious/noExplicitAny: better-auth 各方法签名不同，替身按名读取后由调用方收窄
type StubFunction = (...args: any[]) => any;

/** better-auth `auth.api` 中会被用例替换的方法集合。 */
export interface AuthApiStubs {
  signUpEmail: StubFunction;
  listApiKeys: StubFunction;
  deleteApiKey: StubFunction;
  createApiKey: StubFunction;
  addMember: StubFunction;
  getFullOrganization: StubFunction;
  updateOrganization: StubFunction;
  deleteOrganization: StubFunction;
  setActiveOrganization: StubFunction;
  removeMember: StubFunction;
  updateMemberRole: StubFunction;
  listMembers: StubFunction;
  listOrganizations: StubFunction;
  createOrganization: StubFunction;
  verifyApiKey: StubFunction;
  getSession: StubFunction;
}

let authApiStubs: Partial<AuthApiStubs> = {};
let authHandlerStub: ((request: Request) => Response | Promise<Response>) | null = null;

/** 登记 `auth.api` 的替身方法（浅合并，未覆盖方法沿用上一次登记）。 */
export function stubAuthApi(overrides: Partial<AuthApiStubs>): void {
  authApiStubs = { ...authApiStubs, ...overrides };
}

/** 读取已登记的 `auth.api` 替身方法；未登记时抛错，避免被测代码在别处报 "not a function"。 */
export function getAuthApiStub<K extends keyof AuthApiStubs>(name: K): AuthApiStubs[K] {
  const fn = authApiStubs[name];
  if (!fn) throw new Error(`auth.api stub '${String(name)}' not configured, call stubAuthApi() in beforeEach`);
  return fn;
}

/** 登记 better-auth 的 HTTP handler 替身（`/api/auth/*` 直连路由用）。 */
export function stubAuthHandler(handler: (request: Request) => Response | Promise<Response>): void {
  authHandlerStub = handler;
}

/** 读取 handler 替身；未登记返回 null，调用方据此回退到默认响应。 */
export function getAuthHandlerStub(): ((request: Request) => Response | Promise<Response>) | null {
  return authHandlerStub;
}

/** 清空全部认证替身，供用例之间复位。 */
export function resetAuthStubs(): void {
  authApiStubs = {};
  authHandlerStub = null;
}
