"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Actions({ id, status }: { id: string; status: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function act(action: string) {
    setBusy(true);
    await fetch(`/api/split/tests/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    router.refresh();
  }
  async function remove() {
    if (!confirm("Delete this test and all its data?")) return;
    setBusy(true);
    await fetch(`/api/split/tests/${id}`, { method: "DELETE" });
    window.location.href = "/";
  }

  const btn = (bg: string): React.CSSProperties => ({
    padding: "7px 14px", background: bg, color: "#fff", border: 0, borderRadius: 6,
    fontSize: 13, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
  });

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {status !== "running" && <button disabled={busy} style={btn("#6E9277")} onClick={() => act("start")}>Start</button>}
      {status === "running" && <button disabled={busy} style={btn("#D6A35D")} onClick={() => act("pause")}>Pause</button>}
      {status !== "ended" && <button disabled={busy} style={btn("#2E4959")} onClick={() => act("end")}>End</button>}
      <button disabled={busy} style={btn("#c0392b")} onClick={remove}>Delete</button>
    </div>
  );
}
