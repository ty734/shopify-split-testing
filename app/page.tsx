import { getPool, ensureSchema } from "@/lib/db";
import RowActions from "./RowActions";

export const dynamic = "force-dynamic";

async function getTests() {
  await ensureSchema();
  const { rows } = await getPool().query(
    `select t.id, t.name, t.status, t.type, t.started_at,
            (select count(*) from split.variations v where v.test_id = t.id)::int as n_variations,
            (select count(distinct anon_id) from split.events e where e.test_id = t.id and e.name = 'exposure')::int as n_visitors,
            (select case when bool_or(vc.mode = 'edit') then 'Content edits'
                         when bool_or(vc.mode = 'inject') then 'Styles & JavaScript'
                         else 'Content' end
             from split.variation_changes vc join split.variations v on v.id = vc.variation_id where v.test_id = t.id) as mod_type
       from split.tests t
      order by case t.status when 'running' then 0 when 'paused' then 1 when 'draft' then 2 else 3 end, t.created_at desc`
  );
  return rows;
}

const DOT: Record<string, string> = { running: "#2f9e44", paused: "#d6a35d", draft: "#8896a0", ended: "#adb5bd" };
const STATUS_LABEL: Record<string, string> = { running: "Active", paused: "Paused", draft: "Draft", ended: "Ended" };
const fmtVisitors = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "K" : String(n));
function ageDays(started: string | null): string {
  if (!started) return "—";
  const d = Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 86_400_000));
  return d + "d";
}

const INK = "#29404e", SUB = "#6b7885", MUTED = "#8896a0", BORDER = "#e6e9ec";

export default async function Home() {
  const tests = await getTests();
  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "40px 28px 80px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <defs><clipPath id="lwsplit-mark"><rect width="32" height="32" rx="7" /></clipPath></defs>
              <g clipPath="url(#lwsplit-mark)">
                <rect width="32" height="32" fill="#6E9277" />
                <path d="M0 0 L0 32 L32 32 Z" fill="#2E4959" />
                <line x1="0" y1="0" x2="32" y2="32" stroke="#D6A35D" strokeWidth="2.6" />
              </g>
            </svg>
            <span style={{ fontSize: 19, fontWeight: 700, color: "#29404E", letterSpacing: "-0.01em" }}>Living Well Split</span>
          </div>
          <h1 style={{ fontSize: 32, margin: "0 0 6px" }}>Split tests</h1>
          <p style={{ fontSize: 17, color: SUB, margin: 0 }}>Tests that change what shoppers see, where, and for whom.</p>
        </div>
        <a href="/tests/new" style={{ background: "#2E4959", color: "#fff", padding: "13px 22px", borderRadius: 10, fontSize: 17, textDecoration: "none", whiteSpace: "nowrap" }}>+ New test</a>
      </div>

      <div style={{ background: "#fff", border: "1px solid " + BORDER, borderRadius: 16, marginTop: 26, overflow: "hidden" }}>
        <div style={{ padding: "20px 26px", borderBottom: "1px solid " + BORDER, fontSize: 19, color: INK }}>All tests</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 16, minWidth: 820 }}>
            <thead>
              <tr style={{ textAlign: "left", color: MUTED }}>
                <th style={{ ...th, paddingLeft: 26 }}>Name</th>
                <th style={th}>Status</th>
                <th style={th}>Visitors</th>
                <th style={th}>Modifications</th>
                <th style={{ ...th, textAlign: "right", paddingRight: 26 }}></th>
              </tr>
            </thead>
            <tbody>
              {tests.map((t) => (
                <tr key={t.id} style={{ borderTop: "1px solid " + BORDER }}>
                  <td style={{ ...td, paddingLeft: 26 }}>
                    <div style={{ fontSize: 12, letterSpacing: ".08em", color: MUTED, textTransform: "uppercase" }}>{t.type}</div>
                    <a href={`/tests/${t.id}`} style={{ color: INK, textDecoration: "none", fontWeight: 500, fontSize: 18 }}>{t.name}</a>
                  </td>
                  <td style={td}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: SUB }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: DOT[t.status] || MUTED }} />
                      {STATUS_LABEL[t.status] || t.status}
                      {t.started_at && <span style={{ color: MUTED }}>· {ageDays(t.started_at)}</span>}
                    </span>
                  </td>
                  <td style={{ ...td, color: INK }}>{fmtVisitors(t.n_visitors)}</td>
                  <td style={td}>
                    <span style={{ fontSize: 14, padding: "5px 12px", borderRadius: 999, background: "#f1f4f2", color: SUB, whiteSpace: "nowrap" }}>{t.mod_type}</span>
                  </td>
                  <td style={{ ...td, textAlign: "right", paddingRight: 26 }}>
                    <RowActions id={t.id} status={t.status} />
                  </td>
                </tr>
              ))}
              {!tests.length && (
                <tr><td colSpan={5} style={{ padding: 40, textAlign: "center", color: MUTED, fontSize: 17 }}>No tests yet. Create your first one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

const th: React.CSSProperties = { padding: "12px 16px", fontWeight: 500, fontSize: 13, letterSpacing: ".04em", textTransform: "uppercase" };
const td: React.CSSProperties = { padding: "18px 16px", verticalAlign: "middle" };
