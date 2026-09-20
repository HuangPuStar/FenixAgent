/**
 * DB 句柄替身注册表（`getDatabase()` / 宿主 `db` 导出的替身）。
 *
 * Drizzle 的 db 是链式查询构建器，用例直接用一个自定义对象替换它；本注册表只负责持有该对象，
 * 让宿主 preload 的 `mock.module` 转发代理与各包用例读到同一个实例。
 *
 * `getDbStub()` 未登记时返回空对象而不是抛错：宿主 preload 的 mock 工厂在 preload 期就会被求值，
 * 抛错会让所有测试进程启动失败。忘记 `stubDb()` 的用例会在真正调用时得到明确的
 * "xxx is not a function"，比启动期报错更容易定位到用例本身。
 */

// biome-ignore lint/suspicious/noExplicitAny: Drizzle db 对象类型复杂且各包替身形状不同，读取方自行收窄
export type DbStub = Record<string, any>;

let dbStub: DbStub | undefined;

/** 登记本用例使用的 DB 替身。 */
export function stubDb(db: DbStub): void {
  dbStub = db;
}

/** 读取当前 DB 替身；未登记时返回空对象（见文件头注释）。 */
export function getDbStub(): DbStub {
  return dbStub ?? {};
}

/** 清空 DB 替身，供用例之间复位。 */
export function resetDbStub(): void {
  dbStub = undefined;
}
