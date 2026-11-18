"use client";
import { useState } from "react";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(false);
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (r.ok) window.location.href = "/";
    else setErr(true);
  }
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", fontFamily: "system-ui" }}>
      <form onSubmit={submit} style={{ display: "grid", gap: 12, width: 280 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>lw-split</h1>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Password"
          autoFocus
          style={{ padding: "10px 12px", border: "1px solid #ccc", borderRadius: 6 }}
        />
        <button type="submit" style={{ padding: "10px 12px", background: "#2E4959", color: "#fff", border: 0, borderRadius: 6 }}>
          Sign in
        </button>
        {err && <p style={{ color: "#c0392b", margin: 0, fontSize: 13 }}>Wrong password</p>}
      </form>
    </main>
  );
}
