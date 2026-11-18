"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const BORDER = "#d7dce0", INK = "#29404e", SUB = "#6b7885";

export default function RowActions({ id, status }: { id: string; status: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function act(action: string) {
    setBusy(true);
    await fetch(`/api/split/tests/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
    });
    setBusy(false);
    router.refresh();
  }

  async function del() {
    if (!window.confirm("Delete this test permanently? This removes the test and all its data and can't be undone.")) return;
    setBusy(true);
    await fetch(`/api/split/tests/${id}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  const ghost: React.CSSProperties = {
    padding: "8px 16px", borderRadius: 8, fontSize: 15, cursor: busy ? "default" : "pointer",
    border: "1px solid " + BORDER, background: "#fff", color: INK, opacity: busy ? 0.5 : 1, whiteSpace: "nowrap",
  };
  const text: React.CSSProperties = { ...ghost, border: "1px solid transparent", color: SUB };
  const danger: React.CSSProperties = { ...text, color: "#c0392b" };

  return (
    <div style={{ display: "inline-flex", gap: 8, justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
      {status !== "ended" && <button disabled={busy} style={text} onClick={() => act("end")}>End</button>}
      {status === "running" && <button disabled={busy} style={ghost} onClick={() => act("pause")}>Pause</button>}
      {(status === "paused" || status === "draft") && <button disabled={busy} style={ghost} onClick={() => act("start")}>{status === "draft" ? "Start" : "Resume"}</button>}
      {status !== "running" && <button disabled={busy} style={danger} onClick={del}>Delete</button>}
    </div>
  );
}
