// Shared-password gate. The cookie stores a SHA-256 token derived from the
// password, never the password itself. Works in both Edge (middleware) and Node
// runtimes via Web Crypto. Mirrors the attribution app's auth, own cookie name.

export const AUTH_COOKIE = "lw_split_auth";

async function hashToken(pw: string): Promise<string> {
  const data = new TextEncoder().encode("lwsplit::v1::" + pw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Returns null when no password is configured, so the middleware fails CLOSED
// instead of accepting the deterministic hash of the empty password.
export async function expectedToken(): Promise<string | null> {
  if (!process.env.DASHBOARD_PASSWORD) return null;
  return hashToken(process.env.DASHBOARD_PASSWORD);
}
export async function tokenFor(pw: string): Promise<string> {
  return hashToken(pw);
}
export async function verifyPassword(pw: string): Promise<boolean> {
  if (!process.env.DASHBOARD_PASSWORD) return false;
  return (await hashToken(pw)) === (await expectedToken());
}
