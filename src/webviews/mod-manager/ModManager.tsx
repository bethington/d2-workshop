import React, { useEffect, useState } from "react";
import { onMessage, postMessage } from "../shared/vscode-api";

interface QueuedChange {
  type: string;
  uri?: string;
  filePath?: string;
  description?: string;
}

export function ModManager() {
  const [changes, setChanges] = useState<QueuedChange[]>([]);

  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type === "loadQueue") {
        setChanges(msg.changes as QueuedChange[]);
      }
    });
  }, []);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--vscode-panel-border)",
          display: "flex",
          alignItems: "center",
          gap: "12px",
        }}
      >
        <h3 style={{ margin: 0 }}>Save Queue</h3>
        <span style={{ color: "var(--vscode-descriptionForeground)" }}>
          {changes.length} pending change(s)
        </span>
        <button
          style={{
            marginLeft: "auto",
            padding: "4px 12px",
            background: "var(--vscode-button-background)",
            color: "var(--vscode-button-foreground)",
            border: "none",
            cursor: "pointer",
          }}
          onClick={() => postMessage({ type: "publish" })}
          disabled={changes.length === 0}
        >
          Publish All
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "12px" }}>
        {changes.length === 0 ? (
          <p style={{ color: "var(--vscode-descriptionForeground)" }}>
            No pending changes. Edit files in the table editor or binary
            editor to queue changes.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {changes.map((change, i) => (
              <li
                key={i}
                style={{
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--vscode-panel-border)",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span
                  style={{
                    fontSize: "0.8em",
                    padding: "2px 6px",
                    background: "var(--vscode-badge-background)",
                    color: "var(--vscode-badge-foreground)",
                    borderRadius: "2px",
                  }}
                >
                  {change.type}
                </span>
                <span>{change.uri || change.filePath}</span>
                <button
                  style={{
                    marginLeft: "auto",
                    background: "none",
                    border: "none",
                    color: "var(--vscode-errorForeground)",
                    cursor: "pointer",
                  }}
                  onClick={() =>
                    postMessage({ type: "removeChange", index: i })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
