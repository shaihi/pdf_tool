import { useState } from "react";

export default function Home() {
  const [title, setTitle] = useState("Chat Export");
  const [input, setInput] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!input.trim()) {
      setError("Paste chat text or a share URL.");
      return;
    }
    setDownloading(true);
    try {
      const payload = {};
      const maybeUrl = input.trim();
      if (/^https?:\/\//i.test(maybeUrl)) {
        payload.url = maybeUrl;
      } else {
        payload.content = input;
      }
      payload.title = title;

      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Request failed with ${res.status}`);
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title || "chat"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || "Failed to export PDF.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <main style={{ maxWidth: 800, margin: "40px auto", padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Chat ➜ PDF Export</h1>
      <p style={{ color: "#555", marginBottom: 16 }}>
        Paste a <b>shared chat URL</b> (ChatGPT/Gemini/etc) <i>or</i> paste the chat <b>text</b>. Set a title and download as PDF.
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
            placeholder="Paste chat text, or a link like https://chatgpt.com/share/..."
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

        {error && <div style={{ color: "crimson", marginTop: 12 }}>{error}</div>}
      </form>

      <div style={{ marginTop: 24, color: "#666", fontSize: 14 }}>
        Notes: For some share pages, content extraction may vary. If a URL fails, paste the plain text instead.
      </div>
    </main>
  );
}