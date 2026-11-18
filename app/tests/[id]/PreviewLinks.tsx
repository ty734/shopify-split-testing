"use client";

import { useState } from "react";

// "Preview on the storefront" panel: one row per targeted page, one link per arm.
// Links open the real storefront with ?lwsplit_preview=<variationId> so the arm is
// forced regardless of the viewer's bucket, and nothing is recorded. Non-running
// tests additionally carry the signed key that unlocks them in the config.

export type PreviewArm = { id: string; name: string; is_control: boolean };
export type PreviewTarget = { label: string; url: string };

const INK = "#29404e", SUB = "#6b7885", MUTED = "#8896a0", BORDER = "#e6e9ec", SAGE = "#6E9277";

export default function PreviewLinks({
  arms, targets, status, keyParams, note,
}: {
  arms: PreviewArm[];
  targets: PreviewTarget[];
  status: string;
  keyParams: string;   // "" for running tests, "&lwsplit_test=..&lwsplit_key=.." otherwise
  note: string | null;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const link = (target: PreviewTarget, arm: PreviewArm) =>
    `${target.url}${target.url.includes("?") ? "&" : "?"}lwsplit_preview=${arm.id}${keyParams}`;

  async function copy(url: string, tag: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1600);
    } catch {
      window.prompt("Copy this preview link:", url);
    }
  }

  if (!arms.length || !targets.length) return null;

  return (
    <section style={{ background: "#fff", border: "1px solid " + BORDER, borderRadius: 16, margin: "0 0 24px", overflow: "hidden" }}>
      <div style={{ padding: "18px 24px", borderBottom: "1px solid " + BORDER, display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 19, color: INK }}>Preview on the storefront</span>
        <span style={{ fontSize: 15, color: MUTED }}>
          Opens the live page with this arm forced. Nothing is recorded — preview traffic never reaches results.
        </span>
      </div>

      {note && (
        <div style={{ padding: "12px 24px", background: "#FBF7EF", borderBottom: "1px solid " + BORDER, fontSize: 15, color: "#7a5c22" }}>
          {note}
        </div>
      )}

      <div style={{ padding: "8px 24px 20px" }}>
        {targets.map((t) => (
          <div key={t.url} style={{ padding: "14px 0", borderBottom: "1px solid #f2f4f5" }}>
            <div style={{ fontSize: 15, color: SUB, marginBottom: 10, wordBreak: "break-all" }}>{t.label}</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {arms.map((a) => {
                const url = link(t, a);
                const tag = t.url + "|" + a.id;
                return (
                  <span key={a.id} style={{ display: "inline-flex", border: "1px solid " + BORDER, borderRadius: 8, overflow: "hidden" }}>
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        padding: "10px 16px", fontSize: 16, textDecoration: "none",
                        color: a.is_control ? INK : "#fff",
                        background: a.is_control ? "#fff" : SAGE,
                        borderRight: "1px solid " + (a.is_control ? BORDER : "rgba(255,255,255,.35)"),
                      }}
                    >
                      {a.is_control ? "Control" : a.name || "Variant"} ↗
                    </a>
                    <button
                      onClick={() => copy(url, tag)}
                      title="Copy link"
                      style={{
                        padding: "10px 14px", fontSize: 15, cursor: "pointer", border: "none",
                        background: a.is_control ? "#fff" : SAGE, color: a.is_control ? SUB : "#fff",
                      }}
                    >
                      {copied === tag ? "Copied" : "Copy"}
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
        <p style={{ fontSize: 14, color: MUTED, margin: "14px 0 0", lineHeight: 1.6 }}>
          A black <strong>PREVIEW</strong> badge appears top-right on the page so a forced view is never mistaken for real traffic.
          {status === "running" && " These links are safe to share — they can't add exposures to this test."}
        </p>
      </div>
    </section>
  );
}
