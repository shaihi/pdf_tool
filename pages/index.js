import { useState } from "react";

export default function Home() {
  const [urls, setUrls] = useState([""]);
  const [title, setTitle] = useState("Chat Export");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const updateUrl = (idx, value) => {
    const newUrls = [...urls];
    newUrls[idx] = value;
    setUrls(newUrls);
  };

  const addUrlField = () => setUrls([...urls, ""]);
  const removeUrlField = (idx) => setUrls(urls.filter((_, i) => i !== idx));

  async function handleExport() {
    setErrorMsg("");
    setLoading(true);
    try {
      const cleanUrls = urls.map(u => u.trim()).filter(Boolean);
      if (cleanUrls.length === 0) {
        setErrorMsg("Please enter at least one chat share link.");
        setLoading(false);
        return;
      }

      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, urls: cleanUrls })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setErrorMsg(errData.message || "Failed to generate export.");
        setLoading(false);
        return;
      }

      const blob = await res.blob();
      const fileName = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "") + ".zip";
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      console.error(err);
      setErrorMsg("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>Multi-Chat Export</h1>
      {urls.map((u, i) => (
        <div key={i} style={{ display: "flex", marginBottom: 10 }}>
          <input
            type="text"
            value={u}
            onChange={(e) => updateUrl(i, e.target.value)}
            placeholder={`Chat link #${i + 1}`}
            style={{ flex: 1, padding: "8px" }}
          />
          {i > 0 && (
            <button
              onClick={() => removeUrlField(i)}
              style={{ marginLeft: 5 }}
            >
              -
            </button>
          )}
        </div>
      ))}
      <button onClick={addUrlField} style={{ marginBottom: 10 }}>+ Add URL</button>
      <input
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Export Title"
        style={{ width: "100%", padding: "8px", marginBottom: "10px" }}
      />
      <button
        onClick={handleExport}
        disabled={loading}
        style={{
          width: "100%",
          padding: "10px",
          backgroundColor: "#0070f3",
          color: "white",
          border: "none",
          cursor: "pointer",
          fontSize: "16px"
        }}
      >
        {loading ? "Generating..." : "Export as ZIP"}
      </button>
      {errorMsg && (
        <p style={{ color: "red", marginTop: "10px" }}>
          {errorMsg}
        </p>
      )}
    </div>
  );
}