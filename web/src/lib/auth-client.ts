import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { apiKeyClient } from "@better-auth/api-key/client";

export const authClient = createAuthClient({
  baseURL: "", // same origin
  plugins: [organizationClient(), apiKeyClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
