import { useState } from "react";

export default function Home() {
  const [title, setTitle] = useState("Chat Export");
  const [input, setInput] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null); // { message, suggestions[], details? }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!input.trim()) {
      setError({ message: "Paste chat text or a share URL." });
      return;
    }
    setDownloading(true);
    try {
      const payload = {};
      const maybeUrl = input.trim();
      if (/^https?:\/\//i.test(maybeUrl)) payload.url = maybeUrl;
      else payload.content = input;
      payload.title = title;

      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // Try JSON first for structured error
        const ct = res.headers.get("content-type") || "";
        let problem;
        if (ct.includes("application/json")) {
          problem = await res.json();
        } else {
          problem = { message: await res.text() };
        }
        setError(problem);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title || "chat"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e2) {
      setError({ message: e2?.message || "Failed to export PDF." });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main style={{ maxWidth: 800, margin: "40px auto", padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Chat ➜ PDF Export</h1>
      <p style={{ color: "#555", marginBottom: 16 }}>
        Paste a <b>shared chat URL</b> (ChatGPT/Gemini/etc) <i>or</i> the chat <b>text</b>. Then download as PDF.
      </p>

      <form onSubmit={handleSubmit}>
        <label style={{ display: "block", marginBottom: 8 }}>
          Title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Chat Export"
            style={{ width: "100%", padding: 8, marginTop: 4, marginBottom: 16 }}
          />
        </label>

        <label style={{ display: "block", marginBottom: 8 }}>
          Chat text or share URL
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste chat text or a link like https://chatgpt.com/share/..."
            rows={16}
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>

        <button
          type="submit"
          disabled={downloading}
          style={{ marginTop: 16, padding: "10px 16px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
        >
          {downloading ? "Generating..." : "Download PDF"}
        </button>

        {error && (
          <div style={{ marginTop: 12, padding: 12, border: "1px solid #f1c0c0", background: "#fff5f5", borderRadius: 8 }}>
            <div style={{ color: "#a40000", fontWeight: 600 }}>
              {error.message || "Something went wrong."}
            </div>
            {Array.isArray(error.suggestions) && (
              <ul style={{ marginTop: 8, color: "#444" }}>
                {error.suggestions.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            )}
            {error.details && (
              <details style={{ marginTop: 8 }}>
                <summary>Technical details</summary>
                <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(error.details, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
      </form>
    </main>
  );
}