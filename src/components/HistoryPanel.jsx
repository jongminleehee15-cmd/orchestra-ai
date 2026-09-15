import { useState } from "react";
import { SERIF } from "../lib/constants.js";
import { timeAgo } from "../lib/history.js";

function HistoryCard({ entry, onRestore, onDelete, S }) {
  const [hovered, setHovered] = useState(false);
  const doneCount = (entry.scoreParts || []).filter((p) => p.status === "done").length;
  const totalCount = (entry.scoreParts || []).length;
  const instrLabel = totalCount === 1 ? "1 part" : `${totalCount} parts`;

  return (
    <div
      onClick={() => onRestore(entry)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "14px 16px", borderRadius: "6px", cursor: "pointer",
        background: hovered ? S.surface2 : S.surface,
        border: `1px solid ${hovered ? S.gold + "60" : S.border}`,
        transition: "all 0.2s", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h3 style={{ margin: "0 0 3px", fontSize: "15px", fontWeight: 700, color: hovered ? S.gold : S.text, fontFamily: SERIF, transition: "color 0.2s" }}>
          {entry.songTitle || "Untitled"}{entry.songArtist ? ` — ${entry.songArtist}` : ""}
        </h3>
        <p style={{ margin: 0, fontSize: "12px", color: S.muted }}>
          {instrLabel} · {doneCount}/{totalCount} generated · {entry.measures} measures · {entry.style} · {timeAgo(entry.savedAt)}
        </p>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(entry.id); }}
        title="Remove from history"
        style={{
          background: "none", border: "none", color: S.muted, cursor: "pointer",
          fontSize: "15px", padding: "4px 6px", flexShrink: 0,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#d07070")}
        onMouseLeave={(e) => (e.currentTarget.style.color = S.muted)}
      >
        ✕
      </button>
    </div>
  );
}

export default function HistoryPanel({ S, history, onRestore, onDelete, onClearAll }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
        <div>
          <h2 style={{ margin: "0 0 6px", fontSize: "22px", fontWeight: 300, color: S.gold }}>Recent Arrangements</h2>
          <p style={{ margin: 0, fontSize: "13px", color: S.muted }}>
            Your last 5 generated arrangements, kept on this device. Click one to bring it back.
          </p>
        </div>
        {history.length > 0 && (
          <button
            onClick={onClearAll}
            style={{
              padding: "8px 16px", background: "transparent", border: `1px solid ${S.border}`,
              color: S.muted, borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontFamily: SERIF, flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#d07070"; e.currentTarget.style.color = "#d07070"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = S.border; e.currentTarget.style.color = S.muted; }}
          >
            Clear All
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <div style={{ padding: "40px", textAlign: "center", color: S.muted, fontSize: "14px", border: `1px dashed ${S.border}`, borderRadius: "6px" }}>
          No saved arrangements yet — generate one and it'll show up here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {history.map((entry) => (
            <HistoryCard key={entry.id} entry={entry} onRestore={onRestore} onDelete={onDelete} S={S} />
          ))}
        </div>
      )}
    </div>
  );
}
