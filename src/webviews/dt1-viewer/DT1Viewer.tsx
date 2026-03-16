import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onMessage, postMessage } from "../shared/vscode-api";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TileData {
  index: number;
  type: number;
  typeName: string;
  style: number;
  sequence: number;
  direction: number;
  width: number;
  height: number;
  roofHeight: number;
  blockCount: number;
  rgbaBase64: string;
}

interface TileGroup {
  name: string;
  tiles: Array<{ tileIndex: number; isoX: number; isoY: number }>;
}

interface CompanionData {
  source: string;
  palette: string;
  viewMode: "single" | "surround" | "grouped" | "tileset";
  zoom: number;
  filterType: string;
  selectedTileIndex: number;
  groups: TileGroup[];
  activeGroupIndex: number;
  surroundOverrides: any[];
  collisionEdits: any[];
}

// ─── Isometric Constants ────────────────────────────────────────────────────

const ISO_W = 160;
const ISO_H = 80;
const ISO_HW = 80;
const ISO_HH = 40;

function isoToScreen(ix: number, iy: number): { x: number; y: number } {
  return { x: (ix - iy) * ISO_HW, y: (ix + iy) * ISO_HH };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function tileToImageData(tile: TileData): ImageData | null {
  if (tile.width <= 0 || tile.height <= 0) return null;
  try {
    const binary = atob(tile.rgbaBase64);
    const rgba = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i++) rgba[i] = binary.charCodeAt(i);
    return new ImageData(rgba, tile.width, tile.height);
  } catch { return null; }
}

function tileToCanvas(tile: TileData): HTMLCanvasElement | null {
  const imgData = tileToImageData(tile);
  if (!imgData) return null;
  const c = document.createElement("canvas");
  c.width = tile.width;
  c.height = tile.height;
  c.getContext("2d")!.putImageData(imgData, 0, 0);
  return c;
}

function drawCheckerboard(ctx: CanvasRenderingContext2D, w: number, h: number, z: number) {
  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, w, h);
  const s = 8 * z;
  ctx.fillStyle = "#2a2a2a";
  for (let y = 0; y < h; y += s * 2)
    for (let x = 0; x < w; x += s * 2) {
      ctx.fillRect(x, y, s, s);
      ctx.fillRect(x + s, y + s, s, s);
    }
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function DT1Viewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tiles, setTiles] = useState<TileData[]>([]);
  const [companion, setCompanion] = useState<CompanionData | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedTile, setSelectedTile] = useState<number>(0);
  const [filterType, setFilterType] = useState("all");
  const [viewMode, setViewMode] = useState<"single" | "surround" | "grouped" | "tileset">("single");
  const [zoom, setZoom] = useState(2);
  const [showIsoGrid, setShowIsoGrid] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tileIndex: number } | null>(null);
  const [selectedTiles, setSelectedTiles] = useState<Set<number>>(new Set());
  // Surround slots: 8 positions around the center tile, each holds an optional tile index
  const [surroundSlots, setSurroundSlots] = useState<Record<string, number | null>>({
    n: null, ne: null, e: null, se: null, s: null, sw: null, w: null, nw: null,
  });
  const [dragTileIndex, setDragTileIndex] = useState<number | null>(null);

  // ─── Message Handling ───────────────────────────────────────────────────

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === "load") {
        setFileName(msg.fileName as string);
        setTiles(msg.tiles as TileData[]);
        setError(msg.error as string | null);
        if (msg.companion) {
          const c = msg.companion as CompanionData;
          setCompanion(c);
          setViewMode(c.viewMode);
          setZoom(c.zoom);
          setFilterType(c.filterType);
          setSelectedTile(c.selectedTileIndex);
        }
      } else if (msg.type === "paletteChanged") {
        setTiles(msg.tiles as TileData[]);
        setCompanion(msg.companion as CompanionData);
      }
    });
    postMessage({ type: "ready" });
    return cleanup;
  }, []);

  // Close context menu on click
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.("[data-context-menu]")) return;
      setContextMenu(null);
    };
    const timer = setTimeout(() => window.addEventListener("click", close), 0);
    return () => { clearTimeout(timer); window.removeEventListener("click", close); };
  }, [contextMenu]);

  // ─── Derived Data ─────────────────────────────────────────────────────────

  const tileTypes = useMemo(() => {
    const types = new Map<number, string>();
    for (const t of tiles) if (!types.has(t.type)) types.set(t.type, t.typeName);
    return Array.from(types.entries()).sort((a, b) => a[0] - b[0]);
  }, [tiles]);

  const filteredTiles = useMemo(() => {
    if (filterType === "all") return tiles;
    return tiles.filter(t => t.type === parseInt(filterType));
  }, [tiles, filterType]);

  const selected = selectedTile < tiles.length ? tiles[selectedTile] : null;

  const similarTiles = useMemo(() => {
    if (!selected) return [];
    return tiles.filter(t => t.type === selected.type && t.style === selected.style);
  }, [selected, tiles]);

  // ─── Companion Persistence ────────────────────────────────────────────────

  const saveCompanion = useCallback((updated: CompanionData) => {
    setCompanion(updated);
    postMessage({ type: "saveCompanion", data: updated });
  }, []);

  // ─── Canvas Rendering ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!canvasRef.current || !selected) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (viewMode === "single") {
      renderSingleTile(ctx, canvas, selected, zoom, showIsoGrid);
    } else if (viewMode === "surround") {
      // Surround mode is rendered as HTML, not on this canvas
      canvas.width = 1;
      canvas.height = 1;
    } else if (viewMode === "grouped") {
      renderGrouped(ctx, canvas, tiles, companion, zoom, showIsoGrid);
    } else if (viewMode === "tileset") {
      renderTileset(ctx, canvas, filteredTiles, zoom);
    }
  }, [selected, viewMode, zoom, showIsoGrid, filteredTiles, companion, tiles, similarTiles]);

  // ─── Event Handlers ───────────────────────────────────────────────────────

  const handleModeChange = (newMode: "single" | "surround" | "grouped" | "tileset") => {
    setViewMode(newMode);
    if (companion) saveCompanion({ ...companion, viewMode: newMode });
  };

  const handleZoomChange = (z: number) => {
    setZoom(z);
    if (companion) saveCompanion({ ...companion, zoom: z });
  };

  const handleFilterChange = (f: string) => {
    setFilterType(f);
    if (companion) saveCompanion({ ...companion, filterType: f });
  };

  const handleTileSelect = (idx: number, e?: React.MouseEvent) => {
    if (e?.ctrlKey || e?.metaKey) {
      // Multi-select toggle
      const next = new Set(selectedTiles);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      setSelectedTiles(next);
    } else if (e?.shiftKey && selectedTile !== null) {
      // Range select
      const start = Math.min(selectedTile, idx);
      const end = Math.max(selectedTile, idx);
      const next = new Set<number>();
      for (const t of filteredTiles) {
        if (t.index >= start && t.index <= end) next.add(t.index);
      }
      setSelectedTiles(next);
    } else {
      setSelectedTile(idx);
      setSelectedTiles(new Set([idx]));
      if (companion) saveCompanion({ ...companion, selectedTileIndex: idx });
    }
  };

  const handleCreateGroup = () => {
    if (!companion || selectedTiles.size < 2) return;
    const name = `Group ${companion.groups.length + 1}`;
    const groupTiles = Array.from(selectedTiles).map((tileIndex, i) => ({
      tileIndex,
      isoX: i % 4,
      isoY: Math.floor(i / 4),
    }));
    const updated = {
      ...companion,
      groups: [...companion.groups, { name, tiles: groupTiles }],
      activeGroupIndex: companion.groups.length,
      viewMode: "grouped" as const,
    };
    saveCompanion(updated);
    setViewMode("grouped");
    setContextMenu(null);
  };

  // ─── Error / Loading ──────────────────────────────────────────────────────

  if (error) return <div style={{ padding: 20, color: "var(--vscode-errorForeground)" }}>Failed to load DT1: {error}</div>;
  if (tiles.length === 0) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--vscode-descriptionForeground)" }}>Loading DT1...</div>;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", outline: "none" }}>
      {/* Toolbar */}
      <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--vscode-panel-border)", display: "flex", alignItems: "center", gap: "12px", flexShrink: 0, fontSize: "0.9em" }}>
        <span style={{ fontWeight: "bold" }}>{fileName}</span>
        <span style={{ color: "var(--vscode-descriptionForeground)" }}>{tiles.length} tiles</span>

        {/* Type filter */}
        <select value={filterType} onChange={e => handleFilterChange(e.target.value)} style={selectStyle}>
          <option value="all">All Types ({tiles.length})</option>
          {tileTypes.map(([type, name]) => (
            <option key={type} value={type}>{name} ({tiles.filter(t => t.type === type).length})</option>
          ))}
        </select>

        {/* View mode */}
        <select value={viewMode} onChange={e => handleModeChange(e.target.value as any)} style={selectStyle}>
          <option value="single">Single Tile</option>
          <option value="surround">Auto-Surround</option>
          <option value="grouped">Grouped</option>
          <option value="tileset">Tileset</option>
        </select>

        {/* Palette */}
        {companion && (
          <select
            value={companion.palette}
            onChange={e => postMessage({ type: "changePalette", palette: e.target.value })}
            style={selectStyle}
          >
            <option value="act1">Act 1</option>
            <option value="act2">Act 2</option>
            <option value="act3">Act 3</option>
            <option value="act4">Act 4</option>
            <option value="act5">Act 5</option>
            {companion.palette && !["act1","act2","act3","act4","act5"].includes(companion.palette) && (
              <option value={companion.palette}>{companion.palette.split(/[/\\]/).pop()}</option>
            )}
            <option value="__custom__">Custom...</option>
          </select>
        )}

        {/* Iso grid toggle */}
        <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.85em" }}>
          <input type="checkbox" checked={showIsoGrid} onChange={() => setShowIsoGrid(!showIsoGrid)} />
          Grid
        </label>

        {/* Zoom */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px" }}>
          <span>Zoom:</span>
          <input type="range" min="1" max="8" value={zoom} onChange={e => handleZoomChange(Number(e.target.value))} style={{ width: "80px" }} />
          <span>{zoom}x</span>
        </div>

        <button onClick={() => { if (selected) postMessage({ type: "openInGimp", tileIndex: selected.index }); }} style={btnStyle}>Open in GIMP</button>
        <button onClick={() => { if (selected) postMessage({ type: "importFromGimp", tileIndex: selected.index }); }} style={btnStyle}>Import</button>
        {viewMode === "tileset" && (
          <button onClick={() => postMessage({ type: "exportTileset" })} style={btnStyle}>Export Tileset</button>
        )}
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Canvas / Surround View */}
        <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", background: "#1a1a1a" }}>
          {viewMode === "surround" && selected ? (
            <SurroundView
              centerTile={selected}
              allTiles={tiles}
              slots={surroundSlots}
              zoom={zoom}
              showGrid={showIsoGrid}
              onDropTile={(slot, tileIndex) => {
                const next = { ...surroundSlots, [slot]: tileIndex };
                setSurroundSlots(next);
              }}
              onClearSlot={(slot) => {
                const next = { ...surroundSlots, [slot]: null };
                setSurroundSlots(next);
              }}
            />
          ) : (
            <canvas ref={canvasRef} style={{ imageRendering: "pixelated", border: "1px solid var(--vscode-panel-border)" }} />
          )}
        </div>

        {/* Properties panel */}
        {selected && (
          <div style={{ width: "200px", flexShrink: 0, borderLeft: "1px solid var(--vscode-panel-border)", overflow: "auto", padding: "8px", background: "var(--vscode-sideBar-background)", fontSize: "0.8em" }}>
            <div style={{ fontWeight: "bold", marginBottom: "8px" }}>Tile {selected.index}</div>
            <PropRow label="Type" value={selected.typeName} />
            <PropRow label="Style" value={String(selected.style)} />
            <PropRow label="Sequence" value={String(selected.sequence)} />
            <PropRow label="Direction" value={String(selected.direction)} />
            <PropRow label="Size" value={`${selected.width}\u00D7${selected.height}`} />
            <PropRow label="Roof Height" value={String(selected.roofHeight)} />
            <PropRow label="Blocks" value={String(selected.blockCount)} />

            {/* Collision grid */}
            <div style={{ marginTop: "12px", borderTop: "1px solid var(--vscode-panel-border)", paddingTop: "8px" }}>
              <div style={{ fontWeight: "bold", marginBottom: "4px", fontSize: "0.85em" }}>Collision (5x5)</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "1px", width: "100px" }}>
                {Array.from({ length: 25 }, (_, i) => (
                  <div
                    key={i}
                    style={{
                      width: "18px", height: "18px",
                      background: "rgba(255,0,0,0.3)",
                      border: "1px solid rgba(255,255,0,0.3)",
                      cursor: "pointer",
                    }}
                    title={`Sub-tile ${i}: Click to toggle flags`}
                    onClick={() => {
                      // TODO: Toggle collision flags
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Groups list */}
            {companion && companion.groups.length > 0 && (
              <div style={{ marginTop: "12px", borderTop: "1px solid var(--vscode-panel-border)", paddingTop: "8px" }}>
                <div style={{ fontWeight: "bold", marginBottom: "4px", fontSize: "0.85em" }}>Groups</div>
                {companion.groups.map((g, i) => (
                  <div
                    key={i}
                    onClick={() => {
                      const updated = { ...companion, activeGroupIndex: i, viewMode: "grouped" as const };
                      saveCompanion(updated);
                      setViewMode("grouped");
                    }}
                    style={{
                      padding: "2px 4px", cursor: "pointer", borderRadius: "2px",
                      background: companion.activeGroupIndex === i ? "var(--vscode-list-activeSelectionBackground)" : "transparent",
                      fontSize: "0.85em",
                    }}
                  >
                    {g.name} ({g.tiles.length} tiles)
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div data-context-menu style={{
          position: "fixed", left: contextMenu.x, top: contextMenu.y,
          background: "var(--vscode-menu-background, #252526)", border: "1px solid var(--vscode-menu-border, #454545)",
          borderRadius: "4px", padding: "4px 0", zIndex: 1000, minWidth: "160px", boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        }}>
          <MenuItem label="View Surrounds" onClick={() => { setViewMode("surround"); setContextMenu(null); }} />
          {selectedTiles.size >= 2 && (
            <MenuItem label={`Create Group (${selectedTiles.size} tiles)`} onClick={handleCreateGroup} />
          )}
        </div>
      )}

      {/* Tile strip */}
      <div style={{ height: "72px", borderTop: "1px solid var(--vscode-panel-border)", display: "flex", flexShrink: 0, background: "var(--vscode-sideBar-background)" }}>
        <div style={{ flex: 1, display: "flex", gap: "2px", padding: "4px 8px", overflowX: "auto" }}>
          {filteredTiles.map(tile => (
            <TileThumb
              key={tile.index}
              tile={tile}
              selected={selectedTile === tile.index}
              multiSelected={selectedTiles.has(tile.index)}
              draggable={viewMode === "surround"}
              onClick={(e) => handleTileSelect(tile.index, e)}
              onContextMenu={(e) => {
                e.preventDefault();
                handleTileSelect(tile.index);
                setContextMenu({ x: e.clientX, y: e.clientY, tileIndex: tile.index });
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Rendering Functions ──────────────────────────────────────────────────────

// ─── Surround View Component ────────────────────────────────────────────────

/** Isometric neighbor offsets for each slot */
const ISO_SLOT_OFFSETS: Array<{ key: string; label: string; isoX: number; isoY: number }> = [
  { key: "n",  label: "N",  isoX:  0, isoY: -1 },
  { key: "ne", label: "NE", isoX:  1, isoY: -1 },
  { key: "e",  label: "E",  isoX:  1, isoY:  0 },
  { key: "se", label: "SE", isoX:  1, isoY:  1 },
  { key: "s",  label: "S",  isoX:  0, isoY:  1 },
  { key: "sw", label: "SW", isoX: -1, isoY:  1 },
  { key: "w",  label: "W",  isoX: -1, isoY:  0 },
  { key: "nw", label: "NW", isoX: -1, isoY: -1 },
];

function SurroundView({ centerTile, allTiles, slots, zoom, showGrid, onDropTile, onClearSlot }: {
  centerTile: TileData;
  allTiles: TileData[];
  slots: Record<string, number | null>;
  zoom: number;
  showGrid: boolean;
  onDropTile: (slot: string, tileIndex: number) => void;
  onClearSlot: (slot: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Compute all screen positions for center + 8 slots
  const positions = useMemo(() => {
    const hw = ISO_HW * zoom;
    const hh = ISO_HH * zoom;

    // Center tile screen position at iso (0,0)
    const all: Array<{
      key: string; label: string;
      screenX: number; screenY: number;
      tileIndex: number | null;
      isCenter: boolean;
    }> = [];

    // Add center
    all.push({
      key: "center", label: "Center",
      screenX: 0, screenY: 0,
      tileIndex: centerTile.index,
      isCenter: true,
    });

    // Add 8 neighbor slots
    for (const slot of ISO_SLOT_OFFSETS) {
      const s = isoToScreen(slot.isoX, slot.isoY);
      all.push({
        key: slot.key, label: slot.label,
        screenX: s.x * zoom, screenY: s.y * zoom,
        tileIndex: slots[slot.key],
        isCenter: false,
      });
    }

    // Compute bounding box including both tiles AND iso grid diamonds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of all) {
      const tile = p.isCenter
        ? centerTile
        : (p.tileIndex !== null ? allTiles.find(t => t.index === p.tileIndex) : null);
      const tw = tile ? tile.width * zoom : ISO_W * zoom;
      const th = tile ? tile.height * zoom : ISO_H * zoom;

      // Tile draw position (centered horizontally, bottom aligned to baseline)
      const drawX = p.screenX - tw / 2;
      const drawY = p.screenY - th + hh;
      minX = Math.min(minX, drawX);
      minY = Math.min(minY, drawY);
      maxX = Math.max(maxX, drawX + tw);
      maxY = Math.max(maxY, drawY + th);

      // Also include the iso diamond bounds at this position
      minX = Math.min(minX, p.screenX - hw);
      minY = Math.min(minY, p.screenY - hh);
      maxX = Math.max(maxX, p.screenX + hw);
      maxY = Math.max(maxY, p.screenY + hh);
    }

    return { all, minX, minY, maxX, maxY };
  }, [centerTile, allTiles, slots, zoom]);

  // Render on canvas
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const hw = ISO_HW * zoom;
    const hh = ISO_HH * zoom;
    const pad = 20;
    const w = positions.maxX - positions.minX + pad * 2;
    const h = positions.maxY - positions.minY + pad * 2;

    canvas.width = Math.max(w, 200);
    canvas.height = Math.max(h, 200);

    drawCheckerboard(ctx, canvas.width, canvas.height, zoom);

    const offsetX = -positions.minX + pad;
    const offsetY = -positions.minY + pad;

    // Draw isometric grid (only when Grid checkbox is checked)
    if (showGrid) {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      for (let iy = -2; iy <= 2; iy++) {
        for (let ix = -2; ix <= 2; ix++) {
          const s = isoToScreen(ix, iy);
          const cx = s.x * zoom + offsetX;
          const cy = s.y * zoom + offsetY;
          ctx.beginPath();
          ctx.moveTo(cx, cy - hh);
          ctx.lineTo(cx + hw, cy);
          ctx.lineTo(cx, cy + hh);
          ctx.lineTo(cx - hw, cy);
          ctx.closePath();
          ctx.stroke();
        }
      }
    }

    // Draw tiles (neighbors first, then center on top)
    const sorted = [...positions.all].sort((a, b) => {
      if (a.isCenter && !b.isCenter) return 1; // center last
      if (!a.isCenter && b.isCenter) return -1;
      return a.screenY - b.screenY; // back-to-front
    });

    for (const p of sorted) {
      const tile = p.isCenter
        ? centerTile
        : (p.tileIndex !== null ? allTiles.find(t => t.index === p.tileIndex) : null);

      if (!tile) continue;
      const tc = tileToCanvas(tile);
      if (!tc) continue;

      const tw = tile.width * zoom;
      const th = tile.height * zoom;
      const drawX = p.screenX - tw / 2 + offsetX;
      const drawY = p.screenY - th + hh + offsetY;

      ctx.drawImage(tc, drawX, drawY, tw, th);

      // Highlight center
      if (p.isCenter) {
        ctx.strokeStyle = "#007acc";
        ctx.lineWidth = 2;
        ctx.strokeRect(drawX, drawY, tw, th);
      }
    }
  }, [positions, centerTile, allTiles, zoom, showGrid]);

  // Drop zones: overlay invisible drop targets at each slot's screen position
  const hw = ISO_HW * zoom;
  const hh = ISO_HH * zoom;
  const pad = 20;
  const offsetX = -positions.minX + pad;
  const offsetY = -positions.minY + pad;
  const canvasW = Math.max(positions.maxX - positions.minX + pad * 2, 200);
  const canvasH = Math.max(positions.maxY - positions.minY + pad * 2, 200);

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <canvas ref={canvasRef} style={{ imageRendering: "pixelated", display: "block" }} />
      {/* Drop zones for each empty slot */}
      {ISO_SLOT_OFFSETS.map(slot => {
        const s = isoToScreen(slot.isoX, slot.isoY);
        const cx = s.x * zoom + offsetX;
        const cy = s.y * zoom + offsetY;
        const slotTile = slots[slot.key] !== null ? allTiles.find(t => t.index === slots[slot.key]) : null;
        const dropW = slotTile ? slotTile.width * zoom : ISO_W * zoom;
        const dropH = slotTile ? slotTile.height * zoom : ISO_H * zoom;
        const dropX = cx - dropW / 2;
        const dropY = cy - dropH + hh;

        return (
          <SurroundDropZone
            key={slot.key}
            label={slot.label}
            hasTile={slots[slot.key] !== null}
            x={dropX}
            y={dropY}
            w={dropW}
            h={dropH}
            onDrop={(tileIndex) => onDropTile(slot.key, tileIndex)}
            onClear={() => onClearSlot(slot.key)}
          />
        );
      })}
    </div>
  );
}

function SurroundDropZone({ label, hasTile, x, y, w, h, onDrop, onClear }: {
  label: string; hasTile: boolean;
  x: number; y: number; w: number; h: number;
  onDrop: (tileIndex: number) => void; onClear: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      style={{
        position: "absolute",
        left: x, top: y, width: w, height: h,
        border: dragOver ? "2px solid #007acc" : "none",
        background: dragOver ? "rgba(0,122,204,0.15)" : "transparent",
        boxSizing: "border-box",
        cursor: hasTile ? "pointer" : "default",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const idx = parseInt(e.dataTransfer.getData("text/plain"));
        if (!isNaN(idx)) onDrop(idx);
      }}
      onClick={() => { if (hasTile) onClear(); }}
      title={hasTile ? `Click to remove` : `Drag tile here (${label})`}
    >
    </div>
  );
}

/** Renders a single tile on an inline canvas */
function TileCanvas({ tile, zoom }: { tile: TileData; zoom: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const canvas = ref.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = tile.width * zoom;
    canvas.height = tile.height * zoom;
    const tc = tileToCanvas(tile);
    if (tc) ctx.drawImage(tc, 0, 0, tile.width * zoom, tile.height * zoom);
  }, [tile, zoom]);

  return <canvas ref={ref} style={{ imageRendering: "pixelated", display: "block", width: "100%", height: "100%" }} />;
}

// ─── Canvas Rendering Functions ─────────────────────────────────────────────

function renderSingleTile(
  ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
  tile: TileData, zoom: number, showGrid: boolean
) {
  canvas.width = tile.width * zoom;
  canvas.height = tile.height * zoom;
  drawCheckerboard(ctx, canvas.width, canvas.height, zoom);

  const tc = tileToCanvas(tile);
  if (tc) ctx.drawImage(tc, 0, 0, tile.width * zoom, tile.height * zoom);

  if (showGrid && tile.type === 0) {
    // Draw isometric diamond outline for floor tiles
    const hw = ISO_HW * zoom;
    const hh = ISO_HH * zoom;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh);
    ctx.lineTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx - hw, cy);
    ctx.closePath();
    ctx.stroke();
  }
}

function renderSurround(
  ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
  tile: TileData, similar: TileData[], zoom: number, showGrid: boolean
) {
  // 3x3 isometric grid: center = selected tile, neighbors = similar tiles
  const w = ISO_W * zoom;
  const h = ISO_H * zoom;
  const hw = ISO_HW * zoom;
  const hh = ISO_HH * zoom;

  // Canvas needs to fit 3x3 isometric grid
  // Bounding box: 3 tiles wide = 3 * ISO_W, but isometric overlap reduces this
  canvas.width = w * 3;
  canvas.height = h * 3;
  drawCheckerboard(ctx, canvas.width, canvas.height, zoom);

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  const neighbor = similar.length > 0 ? similar[0] : tile;

  // Draw 3x3 grid of isometric positions
  for (let iy = -1; iy <= 1; iy++) {
    for (let ix = -1; ix <= 1; ix++) {
      const isCenter = ix === 0 && iy === 0;
      const useTile = isCenter ? tile : neighbor;
      const tc = tileToCanvas(useTile);
      if (!tc) continue;

      const screen = isoToScreen(ix, iy);
      const drawX = centerX + screen.x * zoom - hw;
      const drawY = centerY + screen.y * zoom - hh;

      ctx.drawImage(tc, drawX, drawY, useTile.width * zoom, useTile.height * zoom);

      if (isCenter) {
        ctx.strokeStyle = "#007acc";
        ctx.lineWidth = 2;
        ctx.strokeRect(drawX, drawY, useTile.width * zoom, useTile.height * zoom);
      }
    }
  }

  if (showGrid) {
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    for (let iy = -2; iy <= 2; iy++) {
      for (let ix = -2; ix <= 2; ix++) {
        const screen = isoToScreen(ix, iy);
        const cx = centerX + screen.x * zoom;
        const cy = centerY + screen.y * zoom;
        ctx.beginPath();
        ctx.moveTo(cx, cy - hh);
        ctx.lineTo(cx + hw, cy);
        ctx.lineTo(cx, cy + hh);
        ctx.lineTo(cx - hw, cy);
        ctx.closePath();
        ctx.stroke();
      }
    }
  }
}

function renderGrouped(
  ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
  allTiles: TileData[], companion: CompanionData | null, zoom: number, showGrid: boolean
) {
  if (!companion || companion.activeGroupIndex < 0 || companion.activeGroupIndex >= companion.groups.length) {
    canvas.width = 200;
    canvas.height = 100;
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, 200, 100);
    ctx.fillStyle = "var(--vscode-descriptionForeground)";
    ctx.font = "12px sans-serif";
    ctx.fillText("No group selected", 40, 50);
    return;
  }

  const group = companion.groups[companion.activeGroupIndex];
  const hw = ISO_HW * zoom;
  const hh = ISO_HH * zoom;

  // Calculate bounding box
  let minSX = Infinity, minSY = Infinity, maxSX = -Infinity, maxSY = -Infinity;
  for (const gt of group.tiles) {
    const s = isoToScreen(gt.isoX, gt.isoY);
    minSX = Math.min(minSX, s.x * zoom);
    minSY = Math.min(minSY, s.y * zoom);
    maxSX = Math.max(maxSX, s.x * zoom + ISO_W * zoom);
    maxSY = Math.max(maxSY, s.y * zoom + ISO_H * zoom);
  }

  const pad = 20;
  canvas.width = (maxSX - minSX) + pad * 2;
  canvas.height = (maxSY - minSY) + pad * 2;
  drawCheckerboard(ctx, canvas.width, canvas.height, zoom);

  for (const gt of group.tiles) {
    const tile = allTiles.find(t => t.index === gt.tileIndex);
    if (!tile) continue;
    const tc = tileToCanvas(tile);
    if (!tc) continue;

    const s = isoToScreen(gt.isoX, gt.isoY);
    const drawX = s.x * zoom - minSX + pad;
    const drawY = s.y * zoom - minSY + pad;
    ctx.drawImage(tc, drawX, drawY, tile.width * zoom, tile.height * zoom);
  }

  if (showGrid) {
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    for (const gt of group.tiles) {
      const s = isoToScreen(gt.isoX, gt.isoY);
      const cx = s.x * zoom - minSX + pad + hw;
      const cy = s.y * zoom - minSY + pad + hh;
      ctx.beginPath();
      ctx.moveTo(cx, cy - hh);
      ctx.lineTo(cx + hw, cy);
      ctx.lineTo(cx, cy + hh);
      ctx.lineTo(cx - hw, cy);
      ctx.closePath();
      ctx.stroke();
    }
  }
}

function renderTileset(
  ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
  tiles: TileData[], zoom: number
) {
  if (tiles.length === 0) {
    canvas.width = 200;
    canvas.height = 100;
    return;
  }

  // Find max tile dimensions
  let maxW = 0, maxH = 0;
  for (const t of tiles) { maxW = Math.max(maxW, t.width); maxH = Math.max(maxH, t.height); }

  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const cellW = maxW * zoom;
  const cellH = maxH * zoom;

  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  drawCheckerboard(ctx, canvas.width, canvas.height, zoom);

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const tc = tileToCanvas(tile);
    if (!tc) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    ctx.drawImage(tc, col * cellW, row * cellH, tile.width * zoom, tile.height * zoom);
  }
}

// ─── Sub-Components ─────────────────────────────────────────────────────────

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
      <span style={{ color: "var(--vscode-descriptionForeground)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "4px 16px", cursor: "pointer", fontSize: "0.85em",
        color: "var(--vscode-menu-foreground, #ccc)",
        background: hovered ? "var(--vscode-menu-selectionBackground, #094771)" : "transparent",
      }}
    >{label}</div>
  );
}

function TileThumb({ tile, selected, multiSelected, onClick, onContextMenu, draggable }: {
  tile: TileData; selected: boolean; multiSelected: boolean;
  onClick: (e: React.MouseEvent) => void; onContextMenu: (e: React.MouseEvent) => void;
  draggable?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sz = 56;
    canvas.width = sz; canvas.height = sz;
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, sz, sz);
    const imgData = tileToImageData(tile);
    if (!imgData) return;
    const tc = document.createElement("canvas");
    tc.width = tile.width; tc.height = tile.height;
    tc.getContext("2d")!.putImageData(imgData, 0, 0);
    const scale = Math.min(sz / tile.width, sz / tile.height);
    const w = tile.width * scale, h = tile.height * scale;
    ctx.drawImage(tc, (sz - w) / 2, (sz - h) / 2, w, h);
  }, [tile]);

  const borderColor = selected ? "var(--vscode-focusBorder)" : multiSelected ? "#007acc66" : "transparent";

  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(tile.index));
        e.dataTransfer.effectAllowed = "copy";
      }}
      style={{
        flexShrink: 0, cursor: draggable ? "grab" : "pointer",
        border: `2px solid ${borderColor}`, borderRadius: "2px", position: "relative",
      }}
    >
      <canvas ref={canvasRef} style={{ width: "56px", height: "56px", imageRendering: "pixelated", display: "block" }} />
      <span style={{
        position: "absolute", bottom: "1px", right: "2px", fontSize: "0.6em",
        color: "var(--vscode-descriptionForeground)", background: "rgba(0,0,0,0.6)", padding: "0 2px",
      }}>{tile.index}</span>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  background: "var(--vscode-dropdown-background)", color: "var(--vscode-dropdown-foreground)",
  border: "1px solid var(--vscode-dropdown-border)", padding: "2px 8px",
};

const btnStyle: React.CSSProperties = {
  background: "var(--vscode-button-secondaryBackground)", color: "var(--vscode-button-secondaryForeground)",
  border: "none", padding: "3px 10px", cursor: "pointer", borderRadius: "2px",
};
