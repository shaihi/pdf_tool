/* pages/challenge.js */
import { useState, useEffect } from "react";

export default function ChallengePage() {
  const [input, setInput] = useState(`[
  {"role":"user","content":"are you sure about that?"},
  {"role":"assistant","content":"Yes, absolutely."},
  {"role":"user","content":"that doesn't add up."}
]`);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch("/api/user-key").then(r => r.json()).then(d => {
      setHasKey(!!d?.hasKey);
    }).catch(() => {});
  }, []);

  async function saveKey() {
    setMsg("");
    try {
      const res = await fetch("/api/user-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "failed");
      setHasKey(true);
      setApiKey("");
      setMsg("Saved API key on server for your session.");
    } catch (e) {
      setMsg("Error: " + (e?.message || "failed to save key"));
    }
  }

  async function clearKey() {
    setMsg("");
    try {
      const res = await fetch("/api/user-key", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "failed");
      setHasKey(false);
      setMsg("Cleared saved API key.");
    } catch (e) {
      setMsg("Error: " + (e?.message || "failed to clear key"));
    }
  }

  async function analyze() {
    setBusy(true);
    setResult(null);
    setMsg("");
    try {
      let payload;
      try {
        payload = JSON.parse(input);
      } catch {
        payload = input;
      }
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "analyze failed");
      setResult(data);
    } catch (e) {
      setMsg("Error: " + (e?.message || "failed to analyze"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{maxWidth: 860, margin: "40px auto", padding: 20, fontFamily: "ui-sans-serif, system-ui"}}>
      <h1>Chat Challenge Check</h1>
      <p>Paste a chat (array of messages, OpenAI-format object, or plain text), then Analyze.</p>

      <section style={{marginTop: 20}}>
        <label style={{display: "block", fontWeight: 600}}>Chat Input</label>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          rows={10}
          style={{width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"}}
        />
        <button onClick={analyze} disabled={busy} style={{marginTop: 10}}>
          {busy ? "Analyzing..." : "Analyze"}
        </button>
      </section>

      <section style={{marginTop: 30, paddingTop: 20, borderTop: "1px solid #ddd"}}>
        <h2>Optional: Set your own OpenAI API Key</h2>
        <p>This stores an encrypted key for your session on the server (KV). You can clear it anytime.</p>
        <input
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          style={{width: "100%"}}
        />
        <div style={{display: "flex", gap: 10, marginTop: 10}}>
          <button onClick={saveKey} disabled={!apiKey}>Save Key</button>
          <button onClick={clearKey} disabled={!hasKey}>Clear Saved Key</button>
          <span style={{alignSelf: "center", color: hasKey ? "green" : "gray"}}>
            {hasKey ? "Key on file for this session" : "No key saved"}
          </span>
        </div>
      </section>

      <section style={{marginTop: 30}}>
        <h2>Result</h2>
        {result ? (
          <pre style={{whiteSpace: "pre-wrap"}}>{JSON.stringify(result, null, 2)}</pre>
        ) : (
          <p>No result yet.</p>
        )}
        {msg && <p style={{color: msg.startsWith("Error") ? "crimson" : "green"}}>{msg}</p>}
      </section>
    </main>
  );
}
