import { getTestFull } from "@/lib/tests";
import { computeOverview, type Overview } from "@/lib/results";
import { previewKey } from "@/lib/preview";
import Actions from "./Actions";
import Dashboard from "./Dashboard";
import PreviewLinks, { type PreviewArm, type PreviewTarget } from "./PreviewLinks";

export const dynamic = "force-dynamic";

const statusColor: Record<string, string> = {
  running: "#2f9e44", paused: "#d6a35d", draft: "#8896a0", ended: "#8896a0",
};

const STOREFRONT = (process.env.STOREFRONT_ORIGIN || "https://your-store.example.com").replace(/\/+$/, "");

// Which storefront URLs is this test actually on? Page rules give the paths for a
// targeted test; price changes carry their own per-PDP path. Anything we can't turn
// into a real URL (regex/contains) falls back to "pick any page yourself".
function previewTargets(rules: any[], changes: any[]): PreviewTarget[] {
  const paths = new Set<string>();
  for (const r of rules) {
    if (r.scope !== "page" || r.key !== "urlPath" || !r.value) continue;
    if (r.op === "equals" || r.op === "startsWith") paths.add(String(r.value));
  }
  for (const c of changes) {
    // url_path means two different things depending on mode. In PRICE mode it
    // SCOPES the rewrite to a page the test renders on, so it is a real preview
    // target. In REDIRECT mode it is the DESTINATION — a page the test never runs
    // on — and listing it offers a preview that can only ever be a no-op, while
    // implying the test lives there. Where a redirect fires is decided purely by
    // the page rules above.
    if (c.mode === "redirect") continue;
    if (c.url_path) paths.add(String(c.url_path));
  }

  if (!paths.size) {
    return [{ label: STOREFRONT + "/ — this test isn't pinned to a URL, so add the parameter to any page", url: STOREFRONT + "/" }];
  }
  return [...paths].sort().map((p) => ({
    label: STOREFRONT + p,
    url: STOREFRONT + (p.startsWith("/") ? p : "/" + p),
  }));
}

const PREVIEW_NOTE: Record<string, string> = {
  draft: "Draft — not on the storefront yet. These links carry a signed key so you can review it before launch; real visitors can't see this test.",
  paused: "Paused — not being served to real traffic. These links carry a signed key so you can still view it.",
  ended: "Ended — no longer served. These links carry a signed key so you can still view what it looked like.",
};

export default async function TestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const full = await getTestFull(id);
  if (!full) return <main style={{ padding: 48, fontSize: 18 }}>Test not found. <a href="/">Back</a></main>;
  const { test, rules, variations, changes } = full;

  // Preview links. A running test needs no key (it's in the public config already);
  // anything else needs the per-test key that unlocks it — see lib/preview.ts.
  const arms: PreviewArm[] = variations.map((v: any) => ({ id: v.id, name: v.name, is_control: !!v.is_control }));
  const targets = previewTargets(rules, changes);
  const key = test.status === "running" ? null : await previewKey(id);
  const keyParams = key ? `&lwsplit_test=${id}&lwsplit_key=${key}` : "";
  const previewNote = test.status === "running" ? null
    : key ? PREVIEW_NOTE[test.status] || null
    : "Preview keys are unavailable because neither SPLIT_API_TOKEN nor DASHBOARD_PASSWORD is set on this deployment.";

  let overview: Overview | null = null;
  let err: string | null = null;
  try { overview = await computeOverview(id); } catch (e) { err = String((e as Error).message || e); }

  return (
    <main style={{ maxWidth: 1360, margin: "0 auto", padding: "32px 28px 80px" }}>
      <a href="/" style={{ color: "#8896a0", fontSize: 15, textDecoration: "none" }}>← all tests</a>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, marginTop: 10 }}>
        <div>
          <h1 style={{ fontSize: 28, margin: "2px 0 8px", lineHeight: 1.2 }}>{test.name}</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 15, color: "#6b7885" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: statusColor[test.status] || "#8896a0" }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: statusColor[test.status] || "#8896a0" }} />{test.status}
            </span>
            {overview && <span>{overview.totalVisitors.toLocaleString()} visitors · {overview.totalOrders} orders · {overview.daysLive} days</span>}
          </div>
        </div>
        <Actions id={id} status={test.status} />
      </div>
      {test.description && <p style={{ fontSize: 16, color: "#516170", maxWidth: 900, lineHeight: 1.6 }}>{test.description}</p>}

      <div style={{ fontSize: 14, color: "#8896a0", margin: "6px 0 24px" }}>
        {rules.length === 0 ? "Targeting all pages, all visitors."
          : "Targeting: " + rules.map((r) => `${r.key} ${r.op} ${r.value}`).join(" · ")}
      </div>

      <PreviewLinks arms={arms} targets={targets} status={test.status} keyParams={keyParams} note={previewNote} />

      {err && <p style={{ color: "#e03131", fontSize: 16 }}>Results error: {err}</p>}
      {overview && <Dashboard testId={id} overview={overview} />}
    </main>
  );
}
