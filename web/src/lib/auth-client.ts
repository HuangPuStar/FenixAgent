import { apiKeyClient } from "@better-auth/api-key/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// 拦截 fetch 请求用于调试
const originalFetch = window.fetch.bind(window);
(window.fetch as any) = async (...args: [RequestInfo | URL, RequestInit?]) => {
  const [input, init] = args;
  const url = typeof input === 'string' ? input : (input as Request).url;

  // 记录所有认证相关请求
  if (url && typeof url === 'string' && url.includes('/api/auth')) {
    console.log('[Auth Fetch] Request:', {
      url,
      method: init?.method || 'GET',
      headers: init?.headers,
      timestamp: new Date().toISOString()
    });
  }

  try {
    const response = await originalFetch(...args);

    if (url && typeof url === 'string' && url.includes('/api/auth')) {
      console.log('[Auth Fetch] Response:', {
        url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        timestamp: new Date().toISOString()
      });

      // 克隆响应以便查看内容
      const clonedResponse = response.clone();
      clonedResponse.text().then(text => {
        try {
          console.log('[Auth Fetch] Response body:', JSON.parse(text));
        } catch {
          if (text.length > 0) {
            console.log('[Auth Fetch] Response body (raw):', text.substring(0, 300));
          }
        }
      });
    }

    return response;
  } catch (error) {
    console.error('[Auth Fetch] Error:', {
      url,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    });
    throw error;
  }
};

export const authClient = createAuthClient({
  baseURL: "", // same origin
  plugins: [organizationClient(), apiKeyClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
