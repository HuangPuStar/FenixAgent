import { apiKeyClient } from "@better-auth/api-key/client";
import { organizationClient, phoneNumberClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: "", // same origin
  plugins: [organizationClient(), phoneNumberClient(), apiKeyClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;

export async function signUpWithPhone(body: { name: string; phoneNumber: string; password: string }) {
  const response = await fetch("/api/auth/sign-up/phone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });

  let json: Record<string, unknown> | null = null;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message =
      (json?.message as string | undefined) || (json?.error as { message?: string } | undefined)?.message || "注册失败";
    return { data: null, error: { message, status: response.status } };
  }

  return { data: json, error: null };
}
