"use client";
import { useEffect, useState } from "react";
import type { Overview, VariationResult, MetricStat } from "@/lib/results";

const POS = "#2f9e44", NEG = "#e03131", GOLD = "#d6a35d", VAR = "#6e9277", CTRL = "#5b7684";
const MUTED = "#8896a0", BORDER = "#e6e9ec", INK = "#29404e", SUB = "#516170";

const STAT_METRICS: { key: string; label: string; primary?: boolean }[] = [
  { key: "profit_per_visitor", label: "Profit per visitor", primary: true },
  { key: "net_revenue_per_visitor", label: "Revenue per visitor" },
  { key: "conversion_rate", label: "Conversion rate" },
  { key: "average_order_value", label: "Average order value" },
  { key: "add_to_cart_rate", label: "Add to cart rate" },
  { key: "sub_per_visitor", label: "Sub enroll / visitor" },
];
const LABEL: Record<string, string> = Object.fromEntries(STAT_METRICS.map((m) => [m.key, m.label]));
// sub_per_visitor has no timeseries (see computeTimeseries). It stays selectable so its
// significance row is still readable; only the chart is suppressed.
const hasTimeseries = (k: string) => k !== "sub_per_visitor";
const isRate = (k: string) => k === "conversion_rate" || k === "add_to_cart_rate" || k === "sub_per_visitor";
const fmtVal = (k: string, v: number) => (isRate(k) ? (v * 100).toFixed(2) + "%" : "$" + v.toFixed(2));
const pctS = (v: number | null) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
const pct = (v: number | null) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
const money0 = (v: number) => (v < 0 ? "−$" : "+$") + Math.abs(Math.round(v)).toLocaleString();

const tab = (on: boolean): React.CSSProperties => ({
  padding: "10px 20px", borderRadius: 999, fontSize: 16, cursor: "pointer", border: "1px solid " + (on ? VAR : BORDER),
  background: on ? "rgba(110,146,119,.12)" : "#fff", color: on ? INK : SUB, fontWeight: on ? 500 : 400,
});
const card: React.CSSProperties = { background: "#fff", border: "1px solid " + BORDER, borderRadius: 14, padding: 22 };

export default function Dashboard({ testId, overview }: { testId: string; overview: Overview }) {
  const [view, setView] = useState<"key" | "details" | "audience">("key");
  const control = overview.variations.find((v) => v.isControl) || overview.variations[0];
  const variant = overview.variations.find((v) => !v.isControl) || overview.variations[0];

  return (
    <div>
      {/* AI-style summary */}
      <Summary overview={overview} control={control} variant={variant} />

      {/* view switcher */}
      <div style={{ display: "flex", gap: 10, margin: "22px 0" }}>
        <div style={tab(view === "key")} onClick={() => setView("key")}>Key metrics</div>
        <div style={tab(view === "details")} onClick={() => setView("details")}>Metric details</div>
        <div style={tab(view === "audience")} onClick={() => setView("audience")}>By audience</div>
      </div>

      {view === "key" && <KeyMetrics variations={overview.variations} control={control} />}
      {view === "details" && <MetricDetails testId={testId} variations={overview.variations} control={control} />}
      {view === "audience" && <Audience testId={testId} />}

      <p style={{ fontSize: 14, color: MUTED, marginTop: 22 }}>
        Profit = net revenue − COGS · {(overview.cogsCoverage * 100).toFixed(0)}% unit cost coverage · order revenue winsorized at 3σ · P(be best) via Bayesian simulation
      </p>
    </div>
  );
}

function Summary({ overview, control, variant }: { overview: Overview; control: VariationResult; variant: VariationResult }) {
  const pm = overview.primaryMetric;
  const rpv = variant.metrics.net_revenue_per_visitor, ppv = variant.metrics.profit_per_visitor, cvr = variant.metrics.conversion_rate;
  const winning = (variant.metrics[pm]?.upliftPct || 0) > 0;
  const beat = variant.metrics[pm]?.probBeat;
  const ready = overview.totalOrders >= 300 && overview.daysLive >= 7;
  return (
    <div style={{ ...card, borderLeft: "4px solid " + (winning ? VAR : NEG) }}>
      <div style={{ fontSize: 18, fontWeight: 500, color: INK }}>
        {winning ? "Trending positive" : "Trending down"} — {ready ? "call it soon" : "still directional"}
      </div>
      <p style={{ fontSize: 17, color: SUB, lineHeight: 1.7, margin: "10px 0 0" }}>
        The variant is showing {pctS(rpv.upliftPct)} revenue per visitor, {pctS(ppv.upliftPct)} profit per visitor,
        and {pctS(cvr.upliftPct)} conversion rate versus control, with {pct(beat)} probability to beat control on the
        primary metric ({LABEL[pm] || pm}). With {overview.totalOrders} orders across {overview.totalVisitors.toLocaleString()} visitors,
        {ready ? " the sample is large enough to act on." : " the sample is still too small for significance — treat as directional and keep watching."}
      </p>
    </div>
  );
}

function KeyMetrics({ variations, control }: { variations: VariationResult[]; control: VariationResult }) {
  const variant = variations.find((v) => !v.isControl) || control;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 }}>
      {STAT_METRICS.map((m) => {
        const c = control.metrics[m.key], v = variant.metrics[m.key];
        const up = v.upliftPct;
        const col = up == null ? MUTED : up > 0 ? POS : NEG;
        const cv = c.value, vv = v.value, max = Math.max(cv, vv, 1e-9);
        return (
          <div key={m.key} style={{ ...card, borderColor: m.primary ? VAR : BORDER }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 17, color: SUB }}>
              {m.primary && <span style={{ color: GOLD, fontSize: 16 }}>★</span>}{m.label}
            </div>
            <div style={{ fontSize: 44, fontWeight: 500, color: col, margin: "10px 0 2px", lineHeight: 1 }}>
              {up == null ? "—" : (up > 0 ? "↑ " : "↓ ") + Math.abs(up * 100).toFixed(1) + "%"}
            </div>
            <div style={{ fontSize: 14, color: MUTED, minHeight: 20 }}>
              {v.upliftLo != null && `${pctS(v.upliftLo)} to ${pctS(v.upliftHi)}`}
              {v.monthlyImpact != null && (isRate(m.key)
                ? ` · est. ${v.monthlyImpact >= 0 ? "+" : ""}${Math.round(v.monthlyImpact).toLocaleString()} orders / mo`
                : ` · est. ${money0(v.monthlyImpact)} / mo`)}
            </div>
            <div style={{ marginTop: 18, fontSize: 15 }}>
              <Row label="Control" val={fmtVal(m.key, cv)} pctW={(cv / max) * 100} color={CTRL} />
              <Row label="Variant" val={fmtVal(m.key, vv)} pctW={(vv / max) * 100} color={VAR} labelColor={VAR} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
function Row({ label, val, pctW, color, labelColor }: { label: string; val: string; pctW: number; color: string; labelColor?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: labelColor || MUTED }}>{label}</span><span style={{ color: INK }}>{val}</span>
      </div>
      <div style={{ background: "#eef1f0", height: 10, borderRadius: 5 }}>
        <div style={{ width: Math.max(2, Math.min(100, pctW)) + "%", height: 10, background: color, borderRadius: 5 }} />
      </div>
    </div>
  );
}

function MetricDetails({ testId, variations, control }: { testId: string; variations: VariationResult[]; control: VariationResult }) {
  const [metric, setMetric] = useState<string>("net_revenue_per_visitor");
  const [gran, setGran] = useState<"hour" | "day" | "week">("day");
  const [cumulative, setCumulative] = useState(true);
  const [ts, setTs] = useState<any>(null);
  useEffect(() => {
    setTs(null);
    if (!hasTimeseries(metric)) return;
    fetch(`/api/split/results/${testId}?view=timeseries&metric=${metric}&granularity=${gran}&cumulative=${cumulative ? 1 : 0}`)
      .then((r) => r.json()).then(setTs).catch(() => setTs({ series: [] }));
  }, [testId, metric, gran, cumulative]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span style={{ fontSize: 16, color: SUB }}>Metric</span>
        <select value={metric} onChange={(e) => setMetric(e.target.value)}
          style={{ fontSize: 16, padding: "8px 12px", borderRadius: 8, border: "1px solid " + BORDER, color: INK }}>
          {STAT_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>

      <div style={{ ...card, marginBottom: 16, overflowX: "auto" }}>
        <div style={{ fontSize: 18, marginBottom: 12, color: INK }}>Statistical significance</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 16 }}>
          <thead><tr style={{ color: MUTED, textAlign: "left" }}>
            <th style={th}>Group</th><th style={thR}>Uplift</th><th style={thR}>P(beat control)</th><th style={thR}>P(be best)</th><th style={{ ...th, paddingLeft: 28 }}>Value · 90% interval</th>
          </tr></thead>
          <tbody>
            {variations.map((v) => {
              const s = v.metrics[metric] as MetricStat;
              const all = variations.map((x) => x.metrics[metric].ciHi);
              const gmax = Math.max(...all, 1e-9);
              return (
                <tr key={v.variationId} style={{ borderTop: "1px solid " + BORDER }}>
                  <td style={{ ...td, color: v.isControl ? SUB : VAR }}>{v.name}</td>
                  <td style={tdR}>{s.upliftPct == null ? "—" : <span style={{ color: s.upliftPct > 0 ? POS : NEG }}>{pctS(s.upliftPct)}</span>}
                    {s.upliftLo != null && <div style={{ fontSize: 12, color: MUTED }}>{pctS(s.upliftLo)} to {pctS(s.upliftHi)}</div>}</td>
                  <td style={tdR}>{pct(s.probBeat)}</td>
                  <td style={{ ...tdR, color: v.isControl ? INK : VAR }}>{pct(s.probBest)}</td>
                  <td style={{ ...td, paddingLeft: 28, minWidth: 260 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, color: MUTED, fontSize: 14 }}>
                      <span>{fmtVal(metric, s.ciLo)}</span>
                      <span style={{ position: "relative", flex: 1, height: 10, background: "#eef1f0", borderRadius: 5 }}>
                        <span style={{ position: "absolute", left: `${(s.ciLo / gmax) * 100}%`, width: `${((s.ciHi - s.ciLo) / gmax) * 100}%`, height: 10, background: v.isControl ? "#cfd6da" : "rgba(110,146,119,.4)", borderRadius: 5 }} />
                        <span style={{ position: "absolute", left: `${(s.value / gmax) * 100}%`, top: -3, width: 3, height: 16, background: v.isControl ? CTRL : VAR }} />
                      </span>
                      <span>{fmtVal(metric, s.ciHi)}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 18, color: INK }}>Time series</span>
          <span style={{ flex: 1 }} />
          {(["hour", "day", "week"] as const).map((g) => (
            <span key={g} style={{ ...tab(gran === g), fontSize: 14, padding: "5px 12px" }} onClick={() => setGran(g)}>{g === "hour" ? "hourly" : g === "day" ? "daily" : "weekly"}</span>
          ))}
          <label style={{ fontSize: 15, color: SUB, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={cumulative} onChange={(e) => setCumulative(e.target.checked)} /> cumulative
          </label>
        </div>
        {!hasTimeseries(metric)
          ? <div style={{ height: 220, display: "grid", placeItems: "center", color: MUTED, textAlign: "center", padding: "0 20px" }}>
              Not charted over time. Subscription enrollment is read from order tags, which the
              per-bucket query doesn&rsquo;t carry — see the significance table above for the trend.
            </div>
          : !ts ? <div style={{ height: 220, display: "grid", placeItems: "center", color: MUTED }}>loading…</div>
          : <TsChart series={ts.series} metric={metric} />}
      </div>
    </div>
  );
}

function TsChart({ series, metric }: { series: { name: string; isControl: boolean; points: { t: string; value: number }[] }[]; metric: string }) {
  const W = 1000, H = 240, P = 44;
  const pts = series.flatMap((s) => s.points.map((p) => p.value));
  const max = Math.max(...pts, 1e-9), n = series[0]?.points.length || 1;
  const x = (i: number) => P + (i / Math.max(1, n - 1)) * (W - P - 12);
  const y = (v: number) => H - 28 - (v / max) * (H - 56);
  const line = (s: (typeof series)[number]) => s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Metric over time by variation" style={{ minWidth: 640 }}>
        <line x1={P} y1={H - 28} x2={W - 12} y2={H - 28} stroke={BORDER} />
        <text x={6} y={20} fontSize={13} fill={MUTED}>{fmtVal(metric, max)}</text>
        <text x={6} y={H - 30} fontSize={13} fill={MUTED}>{fmtVal(metric, 0)}</text>
        {series.map((s) => (
          <g key={s.name}>
            <polyline fill="none" stroke={s.isControl ? CTRL : VAR} strokeWidth={s.isControl ? 2.5 : 3} points={line(s)} />
          </g>
        ))}
      </svg>
      <div style={{ display: "flex", gap: 20, fontSize: 15, color: SUB, marginTop: 4 }}>
        {series.map((s) => (
          <span key={s.name}><span style={{ display: "inline-block", width: 14, height: 3, background: s.isControl ? CTRL : VAR, verticalAlign: "middle", marginRight: 6 }} />{s.name}</span>
        ))}
      </div>
    </div>
  );
}

const DIMS = [
  { k: "device", label: "Desktop / mobile" }, { k: "visitor", label: "New / returning" },
  { k: "channel", label: "Source channels" }, { k: "landing", label: "Landing pages" },
];
function Audience({ testId }: { testId: string }) {
  const [dim, setDim] = useState("device");
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    setData(null);
    fetch(`/api/split/results/${testId}?view=segments&dim=${dim}`).then((r) => r.json()).then(setData).catch(() => setData({ segments: [] }));
  }, [testId, dim]);
  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {DIMS.map((d) => <div key={d.k} style={tab(dim === d.k)} onClick={() => setDim(d.k)}>{d.label}</div>)}
      </div>
      {!data ? <div style={{ ...card, textAlign: "center", color: MUTED }}>loading…</div>
        : data.segments?.length ? data.segments.map((seg: any) => <SegBlock key={seg.segment} seg={seg} />)
          : <div style={{ ...card, color: MUTED }}>No data for this breakdown yet.</div>}
    </div>
  );
}
function SegBlock({ seg }: { seg: { segment: string; group: { variations: VariationResult[] } } }) {
  const total = seg.group.variations.reduce((a, v) => a + v.nVisitors, 0);
  return (
    <div style={{ ...card, marginBottom: 14, overflowX: "auto" }}>
      <div style={{ fontSize: 17, color: INK, marginBottom: 8 }}>{seg.segment} <span style={{ color: MUTED, fontSize: 14 }}>· {total.toLocaleString()} visitors</span></div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 16, minWidth: 810 }}>
        <thead><tr style={{ color: MUTED, textAlign: "left" }}>
          <th style={th}>Group</th><th style={thR}>Visitors</th><th style={thR}>Orders</th>
          <th style={thR}><span style={{ color: GOLD }}>★</span> Profit / vis</th><th style={thR}>Rev / vis</th><th style={thR}>Conv rate</th><th style={thR}>AOV</th><th style={thR}>Sub enroll</th>
        </tr></thead>
        <tbody>
          {seg.group.variations.map((v) => (
            <tr key={v.variationId} style={{ borderTop: "1px solid " + BORDER }}>
              <td style={{ ...td, color: v.isControl ? SUB : VAR }}>{v.name}</td>
              <td style={tdR}>{v.nVisitors.toLocaleString()}</td><td style={tdR}>{v.nOrders}</td>
              <Cell m={v.metrics.profit_per_visitor} k="profit_per_visitor" c={v.isControl} />
              <Cell m={v.metrics.net_revenue_per_visitor} k="net_revenue_per_visitor" c={v.isControl} />
              <Cell m={v.metrics.conversion_rate} k="conversion_rate" c={v.isControl} />
              <Cell m={v.metrics.average_order_value} k="average_order_value" c={v.isControl} />
              <Cell m={v.metrics.sub_per_visitor} k="sub_per_visitor" c={v.isControl} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Cell({ m, k, c }: { m: MetricStat; k: string; c: boolean }) {
  return (
    <td style={tdR}>
      {!c && m.upliftPct != null && (
        <span style={{ fontSize: 12, padding: "1px 7px", borderRadius: 999, marginRight: 6,
          background: m.upliftPct >= 0 ? "rgba(47,158,68,.12)" : "rgba(224,49,49,.12)", color: m.upliftPct >= 0 ? POS : NEG }}>
          {m.upliftPct >= 0 ? "↑" : "↓"}{Math.abs(m.upliftPct * 100).toFixed(0)}%
        </span>
      )}
      {fmtVal(k, m.value)}
    </td>
  );
}

const th: React.CSSProperties = { padding: "10px 12px", fontWeight: 500, fontSize: 14 };
const thR: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "13px 12px" };
const tdR: React.CSSProperties = { ...td, textAlign: "right", color: INK };
