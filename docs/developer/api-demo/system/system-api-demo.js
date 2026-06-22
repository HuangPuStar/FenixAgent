import { createSystemApiClient, logSection, requireValue } from "./common.js";

const action = process.argv[2] ?? "list-users";
const args = process.argv.slice(3);

/**
 * 统一解析 `--key value` 风格的 CLI 参数。
 * demo 保持轻量，不引入额外依赖，但仍尽量让调用方式清晰可读。
 */
function parseOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    options[key] = value ?? "";
    index += 1;
  }

  return options;
}

function buildConfig(options) {
  return {
    baseUrl: (options["base-url"] ?? "http://localhost:3000").replace(/\/+$/, ""),
    systemApiKey: requireValue("system-api-key", options["system-api-key"]),
  };
}

/**
 * 打印脚本使用方式，便于对方快速照抄。
 */
function printUsage() {
  console.log(`Usage:
  bun docs/developer/api-demo/system/system-api-demo.js list-users --system-api-key <key> [--base-url <url>]
    查询用户列表
  bun docs/developer/api-demo/system/system-api-demo.js create-user --system-api-key <key> --email <email> --name <name> --password <password> [--email-verified true] [--base-url <url>]
    创建一个新的平台用户
  bun docs/developer/api-demo/system/system-api-demo.js list-organizations --system-api-key <key> [--base-url <url>]
    查询组织列表
  bun docs/developer/api-demo/system/system-api-demo.js create-organization --system-api-key <key> --name <name> --slug <slug> [--owner-user-id <userId>] [--base-url <url>]
    创建一个新的组织

Required args:
  --system-api-key
    服务启动时通过 RCS_SYSTEM_API_KEYS 配置的 system key

Optional args:
  --base-url
    Fenix 服务地址，默认是 http://localhost:3000
  --email
    create-user 时使用的邮箱
  --name
    create-user / create-organization 时使用的名称
  --password
    create-user 时使用的密码，至少 8 位
  --email-verified
    create-user 时是否直接标记邮箱已验证，可传 true / false
  --slug
    create-organization 时使用的 slug
  --owner-user-id
    create-organization 时可选绑定的 owner 用户 ID
`);
}

/**
 * 读取用户列表。
 * 这里固定使用一页 20 条，重点是演示最小调用方式。
 */
async function listUsers() {
  const config = buildConfig(parseOptions(args));
  const api = createSystemApiClient(config);
  logSection("GET /api/system/users");
  const result = await api.request("/api/system/users?page=1&pageSize=20");
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 创建平台用户。
 * 默认自动生成邮箱，避免多次运行 demo 时与已有数据冲突。
 */
async function createUser() {
  const options = parseOptions(args);
  const config = buildConfig(options);
  const api = createSystemApiClient(config);
  const body = {
    email: requireValue("email", options.email),
    name: requireValue("name", options.name),
    password: requireValue("password", options.password),
    emailVerified: options["email-verified"] === "true",
  };

  logSection("POST /api/system/users");
  console.log(JSON.stringify(body, null, 2));
  const result = await api.request("/api/system/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 读取组织列表。
 */
async function listOrganizations() {
  const config = buildConfig(parseOptions(args));
  const api = createSystemApiClient(config);
  logSection("GET /api/system/organizations");
  const result = await api.request("/api/system/organizations?page=1&pageSize=20");
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 创建组织。
 * 如果传入 SYSTEM_OWNER_USER_ID，会在创建时直接绑定 owner。
 */
async function createOrganization() {
  const options = parseOptions(args);
  const config = buildConfig(options);
  const api = createSystemApiClient(config);
  const body = {
    name: requireValue("name", options.name),
    slug: requireValue("slug", options.slug),
    ...(options["owner-user-id"] ? { ownerUserId: options["owner-user-id"] } : {}),
  };

  logSection("POST /api/system/organizations");
  console.log(JSON.stringify(body, null, 2));
  const result = await api.request("/api/system/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (action === "--help" || action === "-h") {
  printUsage();
  process.exit(0);
}

// CLI 入口分发：保持每个动作只做一类事情，方便调用方直接复制。
switch (action) {
  case "list-users":
    await listUsers();
    break;
  case "create-user":
    await createUser();
    break;
  case "list-organizations":
    await listOrganizations();
    break;
  case "create-organization":
    await createOrganization();
    break;
  default:
    printUsage();
    process.exitCode = 1;
}
