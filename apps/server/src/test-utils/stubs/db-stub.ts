// raw db stub 注册表
// 替代各测试文件中的 mock.module("../db", ...) 调用
// Drizzle 的 db 是链式查询构建器，直接用自定义对象替换

// biome-ignore lint/suspicious/noExplicitAny: Drizzle db 对象类型复杂，stub 用宽松类型
type DbStub = Record<string, any>;

let _dbStub: DbStub | null = null;

export function stubDb(db: DbStub) {
  _dbStub = db;
}

export function getDbStub(): DbStub {
  // 未配置时返回空对象而非抛错，因为 ../db 的 mock.factory 在 preload 阶段就会被调用
  // 测试如果忘记 stubDb()，会在使用时得到 "xxx is not a function" 错误
  return _dbStub ?? ({} as DbStub);
}

export function resetDbStub() {
  _dbStub = null;
}
