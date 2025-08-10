import { useState } from "react";

export default function Home() {
  const [urls, setUrls] = useState([""]);
  const [title, setTitle] = useState("Chat Export");
  const [loadingAll, setLoadingAll] = useState(false);
  const [rowLoading, setRowLoading] = useState(-1);
  const [errorMsg, setErrorMsg] = useState("");

  const addUrlField = () => setUrls([...urls, ""]);
  const removeUrlField = (i) => setUrls(urls.filter((_, idx) => idx !== i));
  const updateUrl = (i, v) => {
    const next = [...urls];
    next[i] = v;
    setUrls(next);
  };

  const saveBlob = async (res, fallbackName) => {
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const match = cd.match(/filename="([^"]+)"/i);
    const filename = match?.[1] || fallbackName;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const postExport = async (body) => {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Export failed");
    }
    return res;
  };

  const handleDownloadAllZip = async () => {
    setErrorMsg("");
    setLoadingAll(true);
    try {
      const clean = urls.map(u => u.trim()).filter(Boolean);
      if (clean.length === 0) throw new Error("Add at least one URL.");
      const res = await postExport({ title, urls: clean });
      await saveBlob(res, `${sanitize(title)}.zip`);
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setLoadingAll(false);
    }
  };

  const handleDownloadRow = async (i) => {
    setErrorMsg("");
    setRowLoading(i);
    try {
      const u = urls[i]?.trim();
      if (!u) throw new Error("URL is empty.");
      const res = await postExport({ title, urls: [u] }); // API returns a single PDF
      const host = safeHost(u);
      await saveBlob(res, `${host}_${Date.now()}.pdf`);
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setRowLoading(-1);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 8 }}>Multi-Chat Export</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Add one or more chat share links. Download each as **PDF** or all as a **ZIP**.
      </p>

      {urls.map((u, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, marginBottom: 10 }}>
          <input
            type="text"
            value={u}
            onChange={(e) => updateUrl(i, e.target.value)}
            placeholder={`Chat link #${i + 1}`}
            style={{ padding: "10px", border: "1px solid #ddd", borderRadius: 8 }}
          />
          <button
            onClick={() => handleDownloadRow(i)}
            disabled={!u.trim() || rowLoading === i}
            style={{
              padding: "10px 12px",
              background: "#0B5FFF",
              color: "white",
              border: 0,
              borderRadius: 8,
              cursor: (!u.trim() || rowLoading === i) ? "not-allowed" : "pointer",
              minWidth: 140
            }}
            title="Download this chat as PDF"
          >
            {rowLoading === i ? "Downloading…" : "Download PDF"}
          </button>
          <button
            onClick={() => removeUrlField(i)}
            disabled={urls.length === 1}
            style={{
              padding: "10px 12px",
              background: "#eee",
              color: "#111",
              border: 0,
              borderRadius: 8,
              cursor: urls.length === 1 ? "not-allowed" : "pointer"
            }}
            title="Remove URL"
          >
            –
          </button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          onClick={addUrlField}
          style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid #ddd", background: "#fff" }}
          title="Add another URL"
        >
          + Add URL
        </button>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Export Title"
          style={{ flex: 1, padding: "10px", border: "1px solid #ddd", borderRadius: 8 }}
        />
        <button
          onClick={handleDownloadAllZip}
          disabled={loadingAll || urls.every(u => !u.trim())}
          style={{
            padding: "10px 12px",
            background: "#111",
            color: "white",
            border: 0,
            borderRadius: 8,
            minWidth: 160,
            cursor: (loadingAll || urls.every(u => !u.trim())) ? "not-allowed" : "pointer"
          }}
          title="Download all as a single ZIP"
        >
          {loadingAll ? "Preparing ZIP…" : "Download ZIP (all)"}
        </button>
      </div>

      {errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}
    </div>
  );
}

function sanitize(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1F]/g, "").slice(0, 100) || "chat";
}

function safeHost(u) {
  try { return new URL(u).hostname.replace(/\./g, "_"); } catch { return "chat"; }
}