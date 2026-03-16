import React, { useEffect, useMemo, useState } from "react";
import { onMessage, postMessage } from "../shared/vscode-api";

interface ColorData { r: number; g: number; b: number; }

interface PL2Data {
  basePalette: ColorData[];
  lightLevels: number; // 32
  invColors: number; // 16
  hueVariations: number; // 111
  textColors: ColorData[];
  textColorNames: string[];
  /** All transforms as arrays of 256 indices, grouped by category */
  transforms: Record<string, number[][]>;
}

function colorStyle(c: ColorData): string {
  return `rgb(${c.r},${c.g},${c.b})`;
}

export function PL2Viewer() {
  const [data, setData] = useState<PL2Data | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("base");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === "load") {
        setFileName(msg.fileName as string);
        setData(msg.data as PL2Data);
        setError(msg.error as string | null);
      }
    });
    postMessage({ type: "ready" });
    return cleanup;
  }, []);

  const categories = useMemo(() => {
    if (!data) return [];
    return [
      { key: "base", label: "Base Palette", count: 1 },
      { key: "light", label: "Light Levels", count: data.lightLevels },
      { key: "inv", label: "Inv Colors", count: data.invColors },
      { key: "hue", label: "Hue Variations", count: data.hueVariations },
      { key: "red", label: "Red Tones", count: 1 },
      { key: "green", label: "Green Tones", count: 1 },
      { key: "blue", label: "Blue Tones", count: 1 },
      { key: "dark", label: "Darkened Shift", count: 1 },
      { key: "text", label: "Text Colors", count: 1 },
    ];
  }, [data]);

  // Get the currently displayed 256-color palette
  const displayPalette = useMemo((): ColorData[] => {
    if (!data) return [];
    if (selectedCategory === "base") return data.basePalette;
    if (selectedCategory === "text") return data.basePalette; // text colors shown separately

    const transforms = data.transforms[selectedCategory];
    if (!transforms || !transforms[selectedIndex]) return data.basePalette;

    // Apply transform: map each index through the base palette
    return transforms[selectedIndex].map(idx => data.basePalette[idx] || { r: 0, g: 0, b: 0 });
  }, [data, selectedCategory, selectedIndex]);

  const currentCount = categories.find(c => c.key === selectedCategory)?.count || 1;

  if (error) return <div style={{ padding: 20, color: "var(--vscode-errorForeground)" }}>Failed to load PL2: {error}</div>;
  if (!data) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--vscode-descriptionForeground)" }}>Loading PL2...</div>;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <div style={{
        padding: "6px 12px", borderBottom: "1px solid var(--vscode-panel-border)",
        display: "flex", alignItems: "center", gap: "12px", flexShrink: 0, fontSize: "0.9em",
      }}>
        <span style={{ fontWeight: "bold" }}>{fileName}</span>

        <select value={selectedCategory} onChange={e => { setSelectedCategory(e.target.value); setSelectedIndex(0); }} style={selectStyle}>
          {categories.map(c => (
            <option key={c.key} value={c.key}>{c.label} ({c.count})</option>
          ))}
        </select>

        {currentCount > 1 && (
          <>
            <input
              type="range" min="0" max={currentCount - 1} value={selectedIndex}
              onChange={e => setSelectedIndex(Number(e.target.value))}
              style={{ width: "120px" }}
            />
            <span style={{ color: "var(--vscode-descriptionForeground)" }}>
              {selectedIndex + 1}/{currentCount}
            </span>
          </>
        )}
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px", background: "#1a1a1a" }}>
        {selectedCategory === "text" ? (
          /* Text colors display */
          <div>
            <div style={{ fontWeight: "bold", marginBottom: "12px", color: "#ccc" }}>Text Colors</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {data.textColors.map((c, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{
                    width: "32px", height: "32px", borderRadius: "4px",
                    background: colorStyle(c), border: "1px solid rgba(255,255,255,0.2)",
                  }} />
                  <span style={{ color: colorStyle(c), fontWeight: "bold" }}>
                    {data.textColorNames[i] || `Color ${i}`}
                  </span>
                  <span style={{ color: "var(--vscode-descriptionForeground)", fontSize: "0.85em" }}>
                    RGB({c.r}, {c.g}, {c.b})
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Palette grid display */
          <div>
            <div style={{ fontWeight: "bold", marginBottom: "12px", color: "#ccc" }}>
              {selectedCategory === "base" ? "Base Palette" : `Transform ${selectedIndex}`} — 256 colors
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(16, 24px)",
              gap: "1px",
            }}>
              {displayPalette.map((c, i) => (
                <div
                  key={i}
                  style={{
                    width: "24px", height: "24px",
                    background: colorStyle(c),
                    border: "1px solid rgba(255,255,255,0.1)",
                    cursor: "pointer",
                  }}
                  title={`Index ${i}: RGB(${c.r}, ${c.g}, ${c.b})`}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: "var(--vscode-dropdown-background)",
  color: "var(--vscode-dropdown-foreground)",
  border: "1px solid var(--vscode-dropdown-border)",
  padding: "2px 8px",
};
