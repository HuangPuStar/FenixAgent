import { getAuth } from "@fenix/identity/server";
import { initializeApplicationInfrastructure } from "@fenix/platform-sdk/server";

// 只初始化认证上下文，不发起数据库操作，避免把构建默认值验证绑到外部数据库。
initializeApplicationInfrastructure({
  database: {},
  moduleConfigs: { identity: { systemAdminPasswordFile: "/unused/password.txt" } },
  redisConnection: null,
});

const context = await getAuth().$context;
console.log(JSON.stringify(context.authCookies.sessionToken));
