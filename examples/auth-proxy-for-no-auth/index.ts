/**
 * Auth Proxy for No-Auth Demo
 *
 * 反向代理 http://8.163.76.248:38879/ 整个站点，
 * 额外提供 /fake/login 接口完成登录并注入 session cookie 到前端。
 *
 * 用法:
 *   deno run --allow-net --allow-env index.ts
 *
 * 登录:
 *   GET  /fake/login?email=...&password=...
 *   POST /fake/login  body: { "email": "...", "password": "..." }
 *
 * 环境变量 (可选):
 *   BACKEND_URL  - 后端地址，默认 http://8.163.76.248:38879
 *   PORT         - 监听端口，默认 8000
 *   DEMO_EMAIL   - 无参数 GET 时使用的演示邮箱
 *   DEMO_PASSWORD- 无参数 GET 时使用的演示密码
 */

const BACKEND = Deno.env.get("BACKEND_URL") ?? "http://8.163.76.248:38879";
const PORT = parseInt(Deno.env.get("PORT") ?? "8000", 10);
const DEMO_EMAIL = Deno.env.get("DEMO_EMAIL") ?? "example@example.com";
const DEMO_PASSWORD = Deno.env.get("DEMO_PASSWORD") ?? "example@example.com";

// ---------------------------------------------------------------------------
// HTML 登录表单 (当 /fake/login 无参数 GET 时显示)
// ---------------------------------------------------------------------------
const LOGIN_FORM_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fake Login</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #f0f2f5; }
  form { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); width: 100%; max-width: 380px; }
  h2 { margin-bottom: 1.5rem; text-align: center; color: #1a1a2e; }
  label { display: block; margin-bottom: 0.3rem; font-size: 0.875rem; color: #555; }
  input { width: 100%; padding: 0.65rem 0.75rem; margin-bottom: 1rem; border: 1px solid #d9d9d9; border-radius: 8px; font-size: 0.95rem; outline: none; transition: border-color 0.2s; }
  input:focus { border-color: #4f46e5; }
  button { width: 100%; padding: 0.7rem; background: #4f46e5; color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; transition: background 0.2s; }
  button:hover { background: #4338ca; }
  .error { color: #e53e3e; font-size: 0.85rem; margin-bottom: 0.75rem; display: none; }
  .hint { text-align: center; margin-top: 1rem; font-size: 0.8rem; color: #999; }
</style>
</head>
<body>
<form id="loginForm">
  <h2>Fake Login</h2>
  <div class="error" id="error"></div>
  <label for="email">Email</label>
  <input type="email" id="email" name="email" required autocomplete="email" />
  <label for="password">Password</label>
  <input type="password" id="password" name="password" required autocomplete="current-password" />
  <button type="submit">登录</button>
  <p class="hint">提交后自动跳转 /ctrl</p>
</form>
<script>
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    const errorEl = document.getElementById("error");
    errorEl.style.display = "none";
    try {
      const res = await fetch("/fake/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        redirect: "follow",
      });
      if (res.redirected) {
        window.location.href = res.url;
      } else {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        errorEl.textContent = data.error || data.message || "登录失败";
        errorEl.style.display = "block";
      }
    } catch (err) {
      errorEl.textContent = "网络错误: " + err.message;
      errorEl.style.display = "block";
    }
  });
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// /fake/login 处理器
// ---------------------------------------------------------------------------
async function handleFakeLogin(req: Request): Promise<Response> {
  let email = "";
  let password = "";

  if (req.method === "POST") {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await req.json();
      email = body.email ?? "";
      password = body.password ?? "";
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      email = formData.get("email")?.toString() ?? "";
      password = formData.get("password")?.toString() ?? "";
    }
  } else {
    // GET: 优先 query params，其次环境变量
    const url = new URL(req.url);
    email = url.searchParams.get("email") ?? DEMO_EMAIL;
    password = url.searchParams.get("password") ?? DEMO_PASSWORD;
  }

  // 无凭证 → 展示登录表单
  if (!email || !password) {
    return new Response(LOGIN_FORM_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  console.log(`[fake/login] Logging in as ${email}...`);

  // 向后端发送真实登录请求
  const loginRes = await fetch(`${BACKEND}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  const setCookieHeader = loginRes.headers.get("set-cookie");

  if (!setCookieHeader) {
    // 登录失败 - 透传后端错误
    const errorBody = await loginRes.text();
    console.log(`[fake/login] Login failed for ${email}, status=${loginRes.status}`);
    return new Response(errorBody, {
      status: loginRes.status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  console.log(`[fake/login] Login OK for ${email}, cookie: ${setCookieHeader.substring(0, 60)}...`);

  // 登录成功 → 设置 cookie 并跳转 /ctrl
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/ctrl",
      "Set-Cookie": setCookieHeader,
    },
  });
}

// ---------------------------------------------------------------------------
// 通用反向代理
// ---------------------------------------------------------------------------
async function proxyRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const targetUrl = `${BACKEND}${url.pathname}${url.search}`;

  // 构建转发 headers，去掉 host（fetch 会自动设置）
  const headers = new Headers(req.headers);
  headers.delete("host");

  // 透传原始请求体
  let body: BodyInit | null = null;
  if (req.body) {
    body = req.body;
  }

  console.log(`[proxy] ${req.method} ${url.pathname}${url.search} -> ${targetUrl}`);

  const proxyRes = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
  });

  // 如果后端返回重定向，改写 Location 为代理域名
  const responseHeaders = new Headers(proxyRes.headers);
  const location = responseHeaders.get("location");
  if (location) {
    try {
      const locUrl = new URL(location);
      // 改写绝对路径重定向
      if (locUrl.hostname === new URL(BACKEND).hostname) {
        responseHeaders.set("location", locUrl.pathname + locUrl.search + locUrl.hash);
      }
    } catch {
      // 已经是相对路径，无需处理
    }
  }

  return new Response(proxyRes.body, {
    status: proxyRes.status,
    statusText: proxyRes.statusText,
    headers: responseHeaders,
  });
}

// ---------------------------------------------------------------------------
// 主路由
// ---------------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/fake/login") {
    return handleFakeLogin(req);
  }

  return proxyRequest(req);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
console.log(`Auth Proxy starting on http://localhost:${PORT}`);
console.log(`Backend: ${BACKEND}`);
console.log(`Fake login: http://localhost:${PORT}/fake/login`);

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, handler);
