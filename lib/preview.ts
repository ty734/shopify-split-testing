// Per-test preview keys. A DRAFT (or paused/ended) test isn't in the public config —
// real traffic must never see it — so previewing one needs an explicit, unguessable
// opt-in on the URL: ?lwsplit_test=<id>&lwsplit_key=<key>.
//
// The key is derived from a server-side secret + the test id, so it is:
//   - not guessable without the secret,
//   - scoped to ONE test (a shared link can't expose the rest of the roster),
//   - stateless (no table, no expiry to manage) and stable, so a link pasted into
//     Slack for a reviewer keeps working until the secret rotates.
//
// It gates VISIBILITY of unreleased content only. It grants no dashboard access and
// no write path, and a preview pageview still records nothing.

const SALT = "lwsplit::preview::v1::";

function secret(): string | null {
  // SPLIT_API_TOKEN is a real random token; DASHBOARD_PASSWORD is a shared human
  // password and a weaker fallback, used only if the token isn't configured.
  return process.env.SPLIT_API_TOKEN || process.env.DASHBOARD_PASSWORD || null;
}

export async function previewKey(testId: string): Promise<string | null> {
  const s = secret();
  if (!s) return null;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SALT + s + "::" + testId));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

export async function verifyPreviewKey(testId: string, key: string | null): Promise<boolean> {
  if (!key) return false;
  if (!/^[0-9a-f-]{8,64}$/i.test(testId)) return false;   // don't hash arbitrary input
  const expected = await previewKey(testId);
  if (!expected || key.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}
