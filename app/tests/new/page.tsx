"use client";
import { useState } from "react";

type Rule = { scope: "page" | "audience"; key: string; op: string; value: string };
type Change = { mode: "inject" | "edit" | "price" | "redirect"; custom_css: string; selectors: string; op: string; insert_type: string; html: string; variant_id: string; test_price: string; url_path: string };
type Variation = { name: string; is_control: boolean; percentage: number; change: Change };

const emptyChange = (): Change => ({ mode: "inject", custom_css: "", selectors: "", op: "replace", insert_type: "beforebegin", html: "", variant_id: "", test_price: "", url_path: "" });

// Values produced by trafficSource() in public/lw-split.js. Offered as a picker
// because typing them by hand is how a test silently targets nobody.
const TRAFFIC_SOURCES: { value: string; label: string }[] = [
  { value: "meta_paid", label: "meta_paid — Facebook / Instagram ads" },
  { value: "google_paid", label: "google_paid — Google Ads" },
  { value: "tiktok_paid", label: "tiktok_paid — TikTok ads" },
  { value: "email", label: "email — Klaviyo / email" },
  { value: "other_tagged", label: "other_tagged — any other utm_source" },
  { value: "direct_or_organic", label: "direct_or_organic — no campaign markers" },
];

export default function NewTest() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [primaryMetric, setPrimaryMetric] = useState("net_revenue_per_visitor");
  const [exclusionGroup, setExclusionGroup] = useState("");
  const [rules, setRules] = useState<Rule[]>([{ scope: "page", key: "urlPath", op: "equals", value: "" }]);
  const [variations, setVariations] = useState<Variation[]>([
    { name: "Control", is_control: true, percentage: 50, change: emptyChange() },
    { name: "Variant", is_control: false, percentage: 50, change: emptyChange() },
  ]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setVar(i: number, patch: Partial<Variation>) {
    setVariations((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  }
  function setChange(i: number, patch: Partial<Change>) {
    setVariations((vs) => vs.map((v, j) => (j === i ? { ...v, change: { ...v.change, ...patch } } : v)));
  }
  function setRule(i: number, patch: Partial<Rule>) {
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    setErr(null); setBusy(true);
    const payload = {
      name, description, primary_metric: primaryMetric,
      exclusion_group: exclusionGroup || null,
      rules: rules.filter((r) => r.value.trim()).map((r) => ({ scope: r.scope, key: r.key, op: r.op, value: r.value })),
      variations: variations.map((v) => ({
        name: v.name, is_control: v.is_control, percentage: Number(v.percentage),
        changes: v.is_control
          ? []
          : [v.change.mode === "inject"
              ? { mode: "inject", custom_css: v.change.custom_css }
              : v.change.mode === "redirect"
              ? { mode: "redirect", url_path: v.change.url_path.trim() }
              : v.change.mode === "price"
              ? { mode: "price", variant_id: v.change.variant_id.trim(), test_price: Number(v.change.test_price), selectors: v.change.selectors.split(",").map((s) => s.trim()).filter(Boolean) }
              : { mode: "edit", selectors: v.change.selectors.split(",").map((s) => s.trim()).filter(Boolean), op: v.change.op, insert_type: v.change.insert_type, html: v.change.html }],
      })),
    };
    const r = await fetch("/api/split/tests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    setBusy(false);
    if (r.ok) window.location.href = `/tests/${j.id}`;
    else setErr(j.error || "failed");
  }

  const total = variations.reduce((s, v) => s + Number(v.percentage || 0), 0);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px" }}>
      <a href="/" style={{ color: "#8896a0", fontSize: 13, textDecoration: "none" }}>← all tests</a>
      <h1 style={{ fontSize: 20 }}>New test</h1>

      <label style={lbl}>Name</label>
      <input style={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="HOME-HERO-01 — what you're testing" />

      <label style={lbl}>Description / hypothesis</label>
      <textarea style={{ ...inp, minHeight: 60 }} value={description} onChange={(e) => setDescription(e.target.value)} />

      <div style={{ display: "flex", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label style={lbl}>Primary metric</label>
          <select style={inp} value={primaryMetric} onChange={(e) => setPrimaryMetric(e.target.value)}>
            <option value="net_revenue_per_visitor">Revenue / visitor</option>
            <option value="conversion_rate">Conversion rate</option>
            <option value="profit_per_visitor">Profit / visitor (needs COGS)</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={lbl}>Exclusion group (optional)</label>
          <input style={inp} value={exclusionGroup} onChange={(e) => setExclusionGroup(e.target.value)} placeholder="shared name = mutually exclusive" />
        </div>
      </div>

      <h2 style={sub}>Targeting <span style={{ fontWeight: 400, textTransform: "none", color: "#8896a0" }}>(empty value = ignore; no rules = all pages/visitors)</span></h2>
      {rules.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <select style={{ ...inp, width: 110 }} value={r.scope} onChange={(e) => setRule(i, { scope: e.target.value as Rule["scope"], key: e.target.value === "page" ? "urlPath" : "device" })}>
            <option value="page">page</option>
            <option value="audience">audience</option>
          </select>
          <select style={{ ...inp, width: 130 }} value={r.key} onChange={(e) => setRule(i, { key: e.target.value })}>
            {r.scope === "page"
              ? <><option value="urlPath">urlPath</option></>
              : <><option value="trafficSource">trafficSource</option><option value="device">device</option><option value="visitor">visitor</option><option value="utm_source">utm_source</option><option value="utm_campaign">utm_campaign</option></>}
          </select>
          <select style={{ ...inp, width: 120 }} value={r.op} onChange={(e) => setRule(i, { op: e.target.value })}>
            {["equals", "contains", "startsWith", "endsWith", "notEquals", "regex"].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {r.key === "trafficSource" ? (
            <select style={inp} value={r.value} onChange={(e) => setRule(i, { value: e.target.value })}>
              <option value="">— choose —</option>
              {TRAFFIC_SOURCES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          ) : (
            <input style={inp} value={r.value} onChange={(e) => setRule(i, { value: e.target.value })} placeholder={r.key === "urlPath" ? "/products/..." : r.key === "device" ? "mobile" : "value"} />
          )}
        </div>
      ))}
      <button style={addBtn} onClick={() => setRules((rs) => [...rs, { scope: "page", key: "urlPath", op: "contains", value: "" }])}>+ rule</button>

      <h2 style={sub}>Variations <span style={{ fontWeight: 400, textTransform: "none", color: total === 100 ? "#6E9277" : "#c0392b" }}>({total}% — must total 100)</span></h2>
      {variations.map((v, i) => (
        <div key={i} style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input style={{ ...inp, flex: 1, margin: 0 }} value={v.name} onChange={(e) => setVar(i, { name: e.target.value })} />
            <input type="number" style={{ ...inp, width: 70, margin: 0 }} value={v.percentage} onChange={(e) => setVar(i, { percentage: Number(e.target.value) })} />
            <label style={{ fontSize: 12, color: "#516170", whiteSpace: "nowrap" }}>
              <input type="radio" name="control" checked={v.is_control} onChange={() => setVariations((vs) => vs.map((x, j) => ({ ...x, is_control: j === i })))} /> control
            </label>
            {variations.length > 2 && <button style={{ ...addBtn, color: "#c0392b" }} onClick={() => setVariations((vs) => vs.filter((_, j) => j !== i))}>×</button>}
          </div>
          {!v.is_control && (
            <div style={{ marginTop: 8 }}>
              <select style={{ ...inp, width: 200 }} value={v.change.mode} onChange={(e) => setChange(i, { mode: e.target.value as Change["mode"] })}>
                <option value="inject">Inject CSS</option>
                <option value="edit">DOM edit (HTML)</option>
                <option value="price">Price test (charge + display)</option>
                <option value="redirect">Redirect to another page</option>
              </select>
              {v.change.mode === "redirect" ? (
                <div>
                  <label style={lbl}>Send this arm to</label>
                  <input style={inp} value={v.change.url_path} onChange={(e) => setChange(i, { url_path: e.target.value })} placeholder="/pages/alternate-landing-page" />
                  <p style={{ fontSize: 12, color: "#8896a0", margin: "2px 0 8px" }}>
                    Same-origin path on this store. Which pages it fires on comes from the page rule above — set that to
                    the page visitors ARRIVE on (e.g. the PDP), not the destination.
                    {" "}<b>fbclid and all utm_* are carried across automatically</b>, so attribution survives the hop.
                  </p>
                  <p style={{ fontSize: 12, color: "#8a6d3b", background: "#fdf6e3", borderLeft: "3px solid #d6a35d", padding: "8px 11px", margin: 0 }}>
                    This arm pays one extra page load the control does not, so a redirect test is slightly biased
                    against itself. A win here is real; a dead heat is ambiguous.
                  </p>
                </div>
              ) : v.change.mode === "price" ? (
                <div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 2 }}>
                      <label style={lbl}>Variant GID (the variant being repriced)</label>
                      <input style={inp} value={v.change.variant_id} onChange={(e) => setChange(i, { variant_id: e.target.value })} placeholder="gid://shopify/ProductVariant/1234567890" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Test price</label>
                      <input type="number" step="0.01" style={inp} value={v.change.test_price} onChange={(e) => setChange(i, { test_price: e.target.value })} placeholder="20.97" />
                    </div>
                  </div>
                  <label style={lbl}>Display price selector(s) — the PDP price node(s) to rewrite (comma-separated)</label>
                  <input style={inp} value={v.change.selectors} onChange={(e) => setChange(i, { selectors: e.target.value })} placeholder=".price__regular .price-item" />
                  <p style={{ fontSize: 12, color: "#8896a0", margin: "2px 0 0" }}>
                    Wholesale (B2B) is auto-excluded at both the runtime and the cart-transform Function — their B2B catalog price is never touched.
                  </p>
                </div>
              ) : v.change.mode === "inject" ? (
                <textarea style={{ ...inp, minHeight: 60, fontFamily: "monospace", fontSize: 12 }} value={v.change.custom_css} onChange={(e) => setChange(i, { custom_css: e.target.value })} placeholder=".selector { display:none !important; }" />
              ) : (
                <div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input style={{ ...inp, flex: 1 }} value={v.change.selectors} onChange={(e) => setChange(i, { selectors: e.target.value })} placeholder="selector(s), comma-separated" />
                    <select style={{ ...inp, width: 110 }} value={v.change.op} onChange={(e) => setChange(i, { op: e.target.value })}>
                      <option value="replace">replace</option><option value="insert">insert</option><option value="remove">remove</option>
                    </select>
                    {v.change.op === "insert" && (
                      <select style={{ ...inp, width: 130 }} value={v.change.insert_type} onChange={(e) => setChange(i, { insert_type: e.target.value })}>
                        {["beforebegin", "afterbegin", "beforeend", "afterend"].map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    )}
                  </div>
                  {v.change.op !== "remove" && (
                    <textarea style={{ ...inp, minHeight: 60, fontFamily: "monospace", fontSize: 12 }} value={v.change.html} onChange={(e) => setChange(i, { html: e.target.value })} placeholder="<div>...</div>" />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      <button style={addBtn} onClick={() => setVariations((vs) => [...vs, { name: `Variant ${vs.length}`, is_control: false, percentage: 0, change: emptyChange() }])}>+ variation</button>

      {err && <p style={{ color: "#c0392b", fontSize: 13 }}>{err}</p>}
      <div style={{ marginTop: 20 }}>
        <button disabled={busy || !name || total !== 100} onClick={submit}
          style={{ padding: "10px 20px", background: "#2E4959", color: "#fff", border: 0, borderRadius: 6, fontSize: 14, cursor: "pointer", opacity: busy || !name || total !== 100 ? 0.5 : 1 }}>
          Create test (draft)
        </button>
      </div>
    </main>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, color: "#8896a0", margin: "12px 0 4px" };
const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #ccc", borderRadius: 6, fontSize: 14, boxSizing: "border-box", marginBottom: 6 };
const sub: React.CSSProperties = { fontSize: 13, textTransform: "uppercase", letterSpacing: "0.05em", color: "#516170", marginTop: 24 };
const addBtn: React.CSSProperties = { background: "none", border: "1px dashed #bbb", borderRadius: 6, padding: "5px 10px", fontSize: 12, color: "#516170", cursor: "pointer" };
