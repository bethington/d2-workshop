import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onMessage, postMessage } from "../shared/vscode-api";

interface FrameLayout {
  canvasX: number;
  canvasY: number;
  width: number;
  height: number;
  direction: number;
  frameIndex: number;
}

interface CompanionData {
  palette: string;
  displayMode: "composite" | "animation" | "button";
  animationSpeed: number;
  zoom: number;
  canvasWidth: number;
  canvasHeight: number;
  frames: FrameLayout[];
}

interface WebviewFrame {
  width: number;
  height: number;
  direction: number;
  frameIndex: number;
  offsetX: number;
  offsetY: number;
  rgbaBase64: string;
}

// Decode base64 RGBA data to ImageData
function frameToImageData(frame: WebviewFrame): ImageData | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  try {
    const binary = atob(frame.rgbaBase64);
    const rgba = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i++) {
      rgba[i] = binary.charCodeAt(i);
    }
    return new ImageData(rgba, frame.width, frame.height);
  } catch {
    return null;
  }
}

/** Recalculate tight canvas bounds from frame positions */
function recalcBounds(updated: CompanionData): CompanionData {
  let maxRight = 0, maxBottom = 0;
  for (const f of updated.frames) {
    maxRight = Math.max(maxRight, f.canvasX + f.width);
    maxBottom = Math.max(maxBottom, f.canvasY + f.height);
  }
  updated.canvasWidth = Math.max(1, maxRight);
  updated.canvasHeight = Math.max(1, maxBottom);
  return updated;
}

export function DC6Viewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frames, setFrames] = useState<WebviewFrame[]>([]);
  const [companion, setCompanion] = useState<CompanionData | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"composite" | "animation" | "button">("composite");
  const [buttonState, setButtonState] = useState<0 | 1>(0); // 0 = unpressed, 1 = pressed
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    frameIndex: number;
  } | null>(null);

  // Drag state
  const [dragging, setDragging] = useState<{
    frameIndex: number;
    startLogicalX: number;
    startLogicalY: number;
    origCanvasX: number;
    origCanvasY: number;
  } | null>(null);

  // Grid snap size = max frame dimensions
  const gridSize = useMemo(() => {
    if (frames.length === 0) return { w: 1, h: 1 };
    let maxW = 0, maxH = 0;
    for (const f of frames) {
      maxW = Math.max(maxW, f.width);
      maxH = Math.max(maxH, f.height);
    }
    return { w: maxW, h: maxH };
  }, [frames]);

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === "load") {
        setFileName(msg.fileName as string);
        setFrames(msg.frames as WebviewFrame[]);
        setError(msg.error as string | null);
        if (msg.companion) {
          const comp = msg.companion as CompanionData;
          setCompanion(comp);
          setMode(comp.displayMode);
          if (comp.zoom && comp.zoom >= 1 && comp.zoom <= 8) {
            setZoom(comp.zoom);
          }
        }
      } else if (msg.type === "frameUpdated") {
        setFrames((prev) => {
          const next = [...prev];
          next[msg.frameIndex as number] = msg.frame as WebviewFrame;
          return next;
        });
        setCompanion(msg.companion as CompanionData);
      } else if (msg.type === "framesReloaded") {
        setFrames(msg.frames as WebviewFrame[]);
        setCompanion(msg.companion as CompanionData);
        setSelectedFrame(null);
      } else if (msg.type === "paletteChanged") {
        setFrames(msg.frames as WebviewFrame[]);
        setCompanion(msg.companion as CompanionData);
      } else if (msg.type === "__gimpFileChanged") {
        // Auto-import: GIMP saved changes, trigger re-import
        postMessage({ type: "importFromGimp" });
      }
    });
    postMessage({ type: "ready" });
    return cleanup;
  }, []);

  // Close context menu on click anywhere (with delay to allow menu item clicks)
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      // Don't close if clicking inside the context menu itself
      const target = e.target as HTMLElement;
      if (target.closest?.("[data-context-menu]")) return;
      setContextMenu(null);
    };
    // Use setTimeout so the listener isn't added during the same event
    const timer = setTimeout(() => {
      window.addEventListener("click", close);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", close);
    };
  }, [contextMenu]);

  // Render composite on canvas whenever frames/companion/zoom change
  useEffect(() => {
    if (!canvasRef.current || frames.length === 0 || !companion) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = companion.canvasWidth;
    const h = companion.canvasHeight;
    canvas.width = w * zoom;
    canvas.height = h * zoom;

    // Clear with checkerboard pattern for transparency
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const checkSize = 8 * zoom;
    ctx.fillStyle = "#2a2a2a";
    for (let y = 0; y < canvas.height; y += checkSize * 2) {
      for (let x = 0; x < canvas.width; x += checkSize * 2) {
        ctx.fillRect(x, y, checkSize, checkSize);
        ctx.fillRect(x + checkSize, y + checkSize, checkSize, checkSize);
      }
    }

    if (mode === "composite") {
      // Draw all frames at their layout positions
      for (let i = 0; i < frames.length && i < companion.frames.length; i++) {
        const frame = frames[i];
        const layout = companion.frames[i];
        const imgData = frameToImageData(frame);
        if (!imgData) continue;

        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = frame.width;
        tmpCanvas.height = frame.height;
        const tmpCtx = tmpCanvas.getContext("2d")!;
        tmpCtx.putImageData(imgData, 0, 0);

        ctx.drawImage(
          tmpCanvas,
          layout.canvasX * zoom,
          layout.canvasY * zoom,
          frame.width * zoom,
          frame.height * zoom
        );

        // Highlight selected frame
        if (selectedFrame === i) {
          ctx.strokeStyle = "#007acc";
          ctx.lineWidth = 2;
          ctx.strokeRect(
            layout.canvasX * zoom,
            layout.canvasY * zoom,
            frame.width * zoom,
            frame.height * zoom
          );
        }
      }
    } else if (mode === "animation") {
      // Animation mode — draw only current frame centered
      if (currentFrame < frames.length) {
        const frame = frames[currentFrame];
        const imgData = frameToImageData(frame);
        if (imgData) {
          const tmpCanvas = document.createElement("canvas");
          tmpCanvas.width = frame.width;
          tmpCanvas.height = frame.height;
          const tmpCtx = tmpCanvas.getContext("2d")!;
          tmpCtx.putImageData(imgData, 0, 0);

          const cx = (canvas.width - frame.width * zoom) / 2;
          const cy = (canvas.height - frame.height * zoom) / 2;
          ctx.drawImage(
            tmpCanvas,
            cx,
            cy,
            frame.width * zoom,
            frame.height * zoom
          );
        }
      }
    } else if (mode === "button") {
      // Button mode — split frames in half, show current state side by side
      const half = Math.ceil(frames.length / 2);
      const stateStart = buttonState === 0 ? 0 : half;
      const stateEnd = buttonState === 0 ? half : frames.length;

      let drawX = 0;
      let maxH = 0;
      for (let i = stateStart; i < stateEnd; i++) {
        const frame = frames[i];
        maxH = Math.max(maxH, frame.height);
      }

      // Center vertically
      const totalW = (() => {
        let tw = 0;
        for (let i = stateStart; i < stateEnd; i++) tw += frames[i].width;
        return tw;
      })();
      const startX = (canvas.width - totalW * zoom) / 2;
      const startY = (canvas.height - maxH * zoom) / 2;

      for (let i = stateStart; i < stateEnd; i++) {
        const frame = frames[i];
        const imgData = frameToImageData(frame);
        if (!imgData) { drawX += frame.width; continue; }

        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = frame.width;
        tmpCanvas.height = frame.height;
        const tmpCtx = tmpCanvas.getContext("2d")!;
        tmpCtx.putImageData(imgData, 0, 0);

        ctx.drawImage(
          tmpCanvas,
          startX + drawX * zoom,
          startY,
          frame.width * zoom,
          frame.height * zoom
        );
        drawX += frame.width;
      }
    }
  }, [frames, companion, zoom, mode, currentFrame, selectedFrame, buttonState]);

  // Animation playback
  useEffect(() => {
    if (!playing || mode !== "animation" || frames.length === 0) return;
    const speed = companion?.animationSpeed || 100;
    const interval = setInterval(() => {
      setCurrentFrame((prev) => (prev + 1) % frames.length);
    }, speed);
    return () => clearInterval(interval);
  }, [playing, mode, frames.length, companion?.animationSpeed]);

  // Hit-test: find topmost frame at logical coordinates
  const hitTestFrame = useCallback(
    (logicalX: number, logicalY: number): number | null => {
      if (!companion) return null;
      for (let i = companion.frames.length - 1; i >= 0; i--) {
        const fl = companion.frames[i];
        if (
          logicalX >= fl.canvasX &&
          logicalX < fl.canvasX + fl.width &&
          logicalY >= fl.canvasY &&
          logicalY < fl.canvasY + fl.height
        ) {
          return i;
        }
      }
      return null;
    },
    [companion]
  );

  // Convert mouse event to logical canvas coordinates
  const toLogical = useCallback(
    (e: MouseEvent | React.MouseEvent): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / zoom,
        y: (e.clientY - rect.top) / zoom,
      };
    },
    [zoom]
  );

  /**
   * Soft-snap: snap dragged frame's left edge to another frame's right edge,
   * and dragged frame's top edge to another frame's bottom edge.
   * Returns snapped position. Threshold = 5 logical pixels.
   */
  const softSnap = useCallback(
    (rawX: number, rawY: number, draggedIndex: number): { x: number; y: number } => {
      if (!companion) return { x: rawX, y: rawY };
      const SNAP_DIST = 5;
      let snapX = rawX;
      let snapY = rawY;
      const draggedFrame = companion.frames[draggedIndex];

      for (let i = 0; i < companion.frames.length; i++) {
        if (i === draggedIndex) continue;
        const other = companion.frames[i];

        // Snap dragged left edge to other's right edge
        const otherRight = other.canvasX + other.width;
        if (Math.abs(rawX - otherRight) < SNAP_DIST) {
          snapX = otherRight;
        }

        // Snap dragged top edge to other's bottom edge
        const otherBottom = other.canvasY + other.height;
        if (Math.abs(rawY - otherBottom) < SNAP_DIST) {
          snapY = otherBottom;
        }

        // Also snap dragged left to other's left (align)
        if (Math.abs(rawX - other.canvasX) < SNAP_DIST) {
          snapX = other.canvasX;
        }

        // Also snap dragged top to other's top (align)
        if (Math.abs(rawY - other.canvasY) < SNAP_DIST) {
          snapY = other.canvasY;
        }
      }

      return { x: snapX, y: snapY };
    },
    [companion]
  );

  // Canvas mouse down — start drag or select, or toggle button state
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (e.button === 2) return; // right-click handled by context menu
      if (mode === "button") {
        setButtonState((prev) => (prev === 0 ? 1 : 0));
        return;
      }
      if (mode !== "composite" || !companion) return;
      const pos = toLogical(e);
      if (!pos) return;

      const hit = hitTestFrame(pos.x, pos.y);
      if (hit !== null) {
        setSelectedFrame(hit);
        const fl = companion.frames[hit];
        setDragging({
          frameIndex: hit,
          startLogicalX: pos.x,
          startLogicalY: pos.y,
          origCanvasX: fl.canvasX,
          origCanvasY: fl.canvasY,
        });
      } else {
        setSelectedFrame(null);
      }
    },
    [mode, companion, hitTestFrame, toLogical]
  );

  // Canvas right-click — context menu
  const handleCanvasContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (mode !== "composite" || !companion) return;
      const pos = toLogical(e);
      if (!pos) return;
      const hit = hitTestFrame(pos.x, pos.y);
      if (hit !== null) {
        setSelectedFrame(hit);
        setContextMenu({ x: e.clientX, y: e.clientY, frameIndex: hit });
      }
    },
    [mode, companion, hitTestFrame, toLogical]
  );

  // Window-level mousemove/mouseup for drag
  useEffect(() => {
    if (!dragging || !companion) return;

    const handleMouseMove = (e: MouseEvent) => {
      const pos = toLogical(e);
      if (!pos) return;

      const dx = pos.x - dragging.startLogicalX;
      const dy = pos.y - dragging.startLogicalY;

      const updated = { ...companion };
      updated.frames = [...updated.frames];
      const fl = { ...updated.frames[dragging.frameIndex] };
      fl.canvasX = dragging.origCanvasX + dx;
      fl.canvasY = dragging.origCanvasY + dy;
      updated.frames[dragging.frameIndex] = fl;
      setCompanion(updated);
    };

    const handleMouseUp = (e: MouseEvent) => {
      const pos = toLogical(e);
      if (!pos) {
        setDragging(null);
        return;
      }

      const dx = pos.x - dragging.startLogicalX;
      const dy = pos.y - dragging.startLogicalY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      const updated = { ...companion };
      updated.frames = [...updated.frames];
      const fl = { ...updated.frames[dragging.frameIndex] };

      if (dist > 3) {
        const rawX = dragging.origCanvasX + dx;
        const rawY = dragging.origCanvasY + dy;

        if (e.shiftKey) {
          // Shift held: snap to grid
          fl.canvasX = Math.round(rawX / gridSize.w) * gridSize.w;
          fl.canvasY = Math.round(rawY / gridSize.h) * gridSize.h;
        } else {
          // Default: soft-snap to adjacent frame edges
          const snapped = softSnap(rawX, rawY, dragging.frameIndex);
          fl.canvasX = Math.round(snapped.x);
          fl.canvasY = Math.round(snapped.y);
        }
      }
      // If dist <= 3, it was a click — keep original position

      updated.frames[dragging.frameIndex] = fl;
      recalcBounds(updated);

      setCompanion(updated);
      postMessage({ type: "saveCompanion", data: updated });
      setDragging(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, companion, toLogical, gridSize, softSnap]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (selectedFrame === null || !companion) return;

      const step = e.shiftKey ? 5 : 1;
      const updated = { ...companion };
      const fl = { ...updated.frames[selectedFrame] };

      switch (e.key) {
        case "ArrowLeft":
          fl.canvasX -= step;
          break;
        case "ArrowRight":
          fl.canvasX += step;
          break;
        case "ArrowUp":
          fl.canvasY -= step;
          break;
        case "ArrowDown":
          fl.canvasY += step;
          break;
        default:
          return;
      }

      e.preventDefault();
      updated.frames = [...updated.frames];
      updated.frames[selectedFrame] = fl;
      setCompanion(updated);
      postMessage({ type: "saveCompanion", data: updated });
    },
    [selectedFrame, companion]
  );

  // Helper to update companion and save
  const updateCompanionAndSave = useCallback(
    (updated: CompanionData) => {
      setCompanion(updated);
      postMessage({ type: "saveCompanion", data: updated });
    },
    []
  );

  // Context menu actions — send to extension which handles confirmations via VS Code dialogs
  const handleInsert = useCallback(
    (position: "before" | "after", frameIndex: number) => {
      setContextMenu(null);
      postMessage({ type: "insertFramePrompt", position, relativeToIndex: frameIndex });
    },
    []
  );

  const handleDeleteFromMenu = useCallback(
    (frameIndex: number) => {
      setContextMenu(null);
      postMessage({ type: "deleteFramePrompt", frameIndex });
    },
    []
  );

  // Add frame to end
  const handleAddFrame = useCallback(() => {
    postMessage({ type: "insertFramePrompt", position: "end" });
  }, []);

  if (error) {
    return (
      <div style={{ padding: 20, color: "var(--vscode-errorForeground)" }}>
        Failed to load DC6: {error}
      </div>
    );
  }

  if (frames.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "var(--vscode-descriptionForeground)",
        }}
      >
        Loading DC6...
      </div>
    );
  }

  return (
    <div
      className="dc6-viewer"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        outline: "none",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: "6px 12px",
          borderBottom: "1px solid var(--vscode-panel-border)",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexShrink: 0,
          fontSize: "0.9em",
        }}
      >
        <span style={{ fontWeight: "bold" }}>{fileName}</span>
        <span style={{ color: "var(--vscode-descriptionForeground)" }}>
          {frames.length} frames
        </span>
        {companion && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "2px",
              color: "var(--vscode-descriptionForeground)",
            }}
          >
            |
            <input
              type="number"
              min="1"
              step="1"
              value={companion.canvasWidth}
              onChange={(e) => {
                const val = Math.max(1, Number(e.target.value));
                const updated = { ...companion, canvasWidth: val };
                setCompanion(updated);
                postMessage({ type: "saveCompanion", data: updated });
              }}
              style={{
                width: "60px",
                background: "var(--vscode-input-background)",
                color: "var(--vscode-input-foreground)",
                border: "1px solid var(--vscode-input-border)",
                padding: "1px 4px",
                fontSize: "inherit",
              }}
            />
            {"\u00D7"}
            <input
              type="number"
              min="1"
              step="1"
              value={companion.canvasHeight}
              onChange={(e) => {
                const val = Math.max(1, Number(e.target.value));
                const updated = { ...companion, canvasHeight: val };
                setCompanion(updated);
                postMessage({ type: "saveCompanion", data: updated });
              }}
              style={{
                width: "60px",
                background: "var(--vscode-input-background)",
                color: "var(--vscode-input-foreground)",
                border: "1px solid var(--vscode-input-border)",
                padding: "1px 4px",
                fontSize: "inherit",
              }}
            />
          </span>
        )}

        <select
          value={mode}
          onChange={(e) => {
            const newMode = e.target.value as "composite" | "animation" | "button";
            setMode(newMode);
            if (companion) {
              const updated = { ...companion, displayMode: newMode };
              // Resize canvas based on mode
              if (newMode === "animation" || newMode === "button") {
                // Canvas = max frame dimensions
                let mw = 0, mh = 0;
                for (const f of frames) { mw = Math.max(mw, f.width); mh = Math.max(mh, f.height); }
                updated.canvasWidth = mw || 1;
                updated.canvasHeight = mh || 1;
              } else {
                // Composite: fit to frame layout positions
                let maxR = 0, maxB = 0;
                for (const f of updated.frames) {
                  maxR = Math.max(maxR, f.canvasX + f.width);
                  maxB = Math.max(maxB, f.canvasY + f.height);
                }
                updated.canvasWidth = Math.max(1, maxR);
                updated.canvasHeight = Math.max(1, maxB);
              }
              setCompanion(updated);
              postMessage({ type: "saveCompanion", data: updated });
            }
          }}
          style={{
            background: "var(--vscode-dropdown-background)",
            color: "var(--vscode-dropdown-foreground)",
            border: "1px solid var(--vscode-dropdown-border)",
            padding: "2px 8px",
          }}
        >
          <option value="composite">Composite</option>
          <option value="animation">Animation</option>
          <option value="button">Button</option>
        </select>

        {companion && (
          <select
            value={companion.palette}
            onChange={(e) => {
              const val = e.target.value;
              if (val === "__custom__") {
                postMessage({ type: "changePalette", palette: "__custom__" });
              } else {
                postMessage({ type: "changePalette", palette: val });
              }
            }}
            style={{
              background: "var(--vscode-dropdown-background)",
              color: "var(--vscode-dropdown-foreground)",
              border: "1px solid var(--vscode-dropdown-border)",
              padding: "2px 8px",
            }}
          >
            <option value="act1">Act 1</option>
            <option value="act2">Act 2</option>
            <option value="act3">Act 3</option>
            <option value="act4">Act 4</option>
            <option value="act5">Act 5</option>
            {companion.palette && !["act1","act2","act3","act4","act5"].includes(companion.palette) && (
              <option value={companion.palette}>
                {companion.palette.split(/[/\\]/).pop() || "Custom"}
              </option>
            )}
            <option value="__custom__">Custom...</option>
          </select>
        )}

        {mode === "animation" && (
          <>
            <button onClick={() => setPlaying(!playing)} style={btnStyle}>
              {playing ? "Pause" : "Play"}
            </button>
            <span style={{ color: "var(--vscode-descriptionForeground)" }}>
              {currentFrame + 1}/{frames.length}
            </span>
          </>
        )}

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <span>Zoom:</span>
          <input
            type="range"
            min="1"
            max="8"
            value={zoom}
            onChange={(e) => {
              const z = Number(e.target.value);
              setZoom(z);
              if (companion) {
                const updated = { ...companion, zoom: z };
                setCompanion(updated);
                postMessage({ type: "saveCompanion", data: updated });
              }
            }}
            style={{ width: "80px" }}
          />
          <span>{zoom}x</span>
        </div>

        {mode === "composite" && (
          <button
            onClick={() => postMessage({ type: "relayout" })}
            style={btnSecondaryStyle}
            title="Re-arrange frames in a grid layout"
          >
            Re-layout
          </button>
        )}

        <button
          onClick={() => postMessage({ type: "openInGimp" })}
          style={btnSecondaryStyle}
        >
          Open in GIMP
        </button>
        <button
          onClick={() => postMessage({ type: "importFromGimp" })}
          style={btnSecondaryStyle}
        >
          Import from GIMP
        </button>
      </div>

      {/* Canvas */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1a1a1a",
        }}
      >
        <canvas
          ref={canvasRef}
          onMouseDown={handleCanvasMouseDown}
          onContextMenu={handleCanvasContextMenu}
          style={{
            imageRendering: "pixelated",
            border: "1px solid var(--vscode-panel-border)",
            cursor: mode === "composite" ? (dragging ? "grabbing" : "pointer") : mode === "button" ? "pointer" : "default",
          }}
        />
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          data-context-menu
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            background: "var(--vscode-menu-background, #252526)",
            border: "1px solid var(--vscode-menu-border, #454545)",
            borderRadius: "4px",
            padding: "4px 0",
            zIndex: 1000,
            minWidth: "140px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          <ContextMenuItem
            label="Insert Before"
            onClick={() => handleInsert("before", contextMenu.frameIndex)}
          />
          <ContextMenuItem
            label="Insert After"
            onClick={() => handleInsert("after", contextMenu.frameIndex)}
          />
          <div style={{ height: "1px", background: "var(--vscode-menu-separatorBackground, #454545)", margin: "4px 0" }} />
          <ContextMenuItem
            label="Delete"
            danger
            onClick={() => handleDeleteFromMenu(contextMenu.frameIndex)}
          />
        </div>
      )}

      {/* Frame strip + properties panel */}
      <div
        style={{
          height: "72px",
          borderTop: "1px solid var(--vscode-panel-border)",
          display: "flex",
          flexShrink: 0,
          background: "var(--vscode-sideBar-background)",
        }}
      >
        {/* Scrollable thumbnails */}
        <div
          style={{
            flex: 1,
            display: "flex",
            gap: "2px",
            padding: "4px 8px",
            overflowX: "auto",
          }}
        >
          {frames.map((frame, i) => (
            <FrameThumb
              key={i}
              frame={frame}
              index={i}
              selected={selectedFrame === i}
              onClick={() => {
                setSelectedFrame(i);
                if (mode === "animation") setCurrentFrame(i);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelectedFrame(i);
                setContextMenu({ x: e.clientX, y: e.clientY, frameIndex: i });
              }}
            />
          ))}
          {/* Add frame button */}
          <div
            onClick={handleAddFrame}
            style={{
              flexShrink: 0,
              width: "56px",
              height: "56px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              border: "2px dashed var(--vscode-descriptionForeground)",
              borderRadius: "2px",
              color: "var(--vscode-descriptionForeground)",
              fontSize: "0.75em",
              fontWeight: "bold",
              marginTop: "2px",
            }}
            title="Add frame"
          >
            + Add
          </div>
        </div>

        {/* Properties panel */}
        <FrameProperties
          selectedFrame={selectedFrame}
          companion={companion}
          frames={frames}
          onUpdateCompanion={updateCompanionAndSave}
          onResizeFrame={(index, newWidth, newHeight) => {
            postMessage({
              type: "resizeFrame",
              frameIndex: index,
              newWidth,
              newHeight,
            });
          }}
        />
      </div>
    </div>
  );
}

function ContextMenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "4px 16px",
        cursor: "pointer",
        color: danger
          ? "var(--vscode-errorForeground)"
          : "var(--vscode-menu-foreground, #ccc)",
        background: hovered
          ? "var(--vscode-menu-selectionBackground, #094771)"
          : "transparent",
        fontSize: "0.85em",
      }}
    >
      {label}
    </div>
  );
}

function FrameProperties({
  selectedFrame,
  companion,
  frames,
  onUpdateCompanion,
  onResizeFrame,
}: {
  selectedFrame: number | null;
  companion: CompanionData | null;
  frames: WebviewFrame[];
  onUpdateCompanion: (updated: CompanionData) => void;
  onResizeFrame: (index: number, newWidth: number, newHeight: number) => void;
}) {
  const [editX, setEditX] = useState("");
  const [editY, setEditY] = useState("");
  const [editW, setEditW] = useState("");
  const [editH, setEditH] = useState("");

  // Sync local edit state when selection changes
  useEffect(() => {
    if (selectedFrame !== null && companion && companion.frames[selectedFrame]) {
      const fl = companion.frames[selectedFrame];
      setEditX(String(fl.canvasX));
      setEditY(String(fl.canvasY));
    }
    if (selectedFrame !== null && frames[selectedFrame]) {
      const f = frames[selectedFrame];
      setEditW(String(f.width));
      setEditH(String(f.height));
    }
  }, [selectedFrame, companion, frames]);

  const commitXY = () => {
    if (selectedFrame === null || !companion) return;
    const x = Number(editX);
    const y = Number(editY);
    if (isNaN(x) || isNaN(y)) return;

    const updated = { ...companion };
    updated.frames = [...updated.frames];
    updated.frames[selectedFrame] = {
      ...updated.frames[selectedFrame],
      canvasX: x,
      canvasY: y,
    };
    recalcBounds(updated);
    onUpdateCompanion(updated);
  };

  const commitWH = () => {
    if (selectedFrame === null) return;
    const w = Number(editW);
    const h = Number(editH);
    if (isNaN(w) || isNaN(h) || w < 1 || h < 1) return;
    const frame = frames[selectedFrame];
    if (w === frame.width && h === frame.height) return;
    onResizeFrame(selectedFrame, w, h);
  };

  const handleKeyDown = (e: React.KeyboardEvent, commitFn: () => void) => {
    if (e.key === "Enter") {
      commitFn();
      (e.target as HTMLInputElement).blur();
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "48px",
    background: "var(--vscode-input-background)",
    color: "var(--vscode-input-foreground)",
    border: "1px solid var(--vscode-input-border)",
    padding: "1px 3px",
    fontSize: "0.8em",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "0.75em",
    color: "var(--vscode-descriptionForeground)",
    minWidth: "12px",
  };

  if (selectedFrame === null || !companion || !companion.frames[selectedFrame]) {
    return (
      <div
        style={{
          width: "200px",
          flexShrink: 0,
          borderLeft: "1px solid var(--vscode-panel-border)",
          padding: "6px 8px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--vscode-descriptionForeground)",
          fontSize: "0.8em",
        }}
      >
        No frame selected
      </div>
    );
  }

  return (
    <div
      style={{
        width: "200px",
        flexShrink: 0,
        borderLeft: "1px solid var(--vscode-panel-border)",
        padding: "4px 8px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: "3px",
        fontSize: "0.85em",
      }}
    >
      {/* Row 1: Frame number */}
      <div style={{ display: "flex", alignItems: "center" }}>
        <span style={{ fontWeight: "bold" }}>Frame {selectedFrame}</span>
      </div>

      {/* Row 2: X, Y */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <span style={labelStyle}>X</span>
        <input
          type="number"
          value={editX}
          onChange={(e) => setEditX(e.target.value)}
          onBlur={commitXY}
          onKeyDown={(e) => handleKeyDown(e, commitXY)}
          style={inputStyle}
        />
        <span style={labelStyle}>Y</span>
        <input
          type="number"
          value={editY}
          onChange={(e) => setEditY(e.target.value)}
          onBlur={commitXY}
          onKeyDown={(e) => handleKeyDown(e, commitXY)}
          style={inputStyle}
        />
      </div>

      {/* Row 3: W, H */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <span style={labelStyle}>W</span>
        <input
          type="number"
          min="1"
          value={editW}
          onChange={(e) => setEditW(e.target.value)}
          onBlur={commitWH}
          onKeyDown={(e) => handleKeyDown(e, commitWH)}
          style={inputStyle}
        />
        <span style={labelStyle}>H</span>
        <input
          type="number"
          min="1"
          value={editH}
          onChange={(e) => setEditH(e.target.value)}
          onBlur={commitWH}
          onKeyDown={(e) => handleKeyDown(e, commitWH)}
          style={inputStyle}
        />
      </div>
    </div>
  );
}

function FrameThumb({
  frame,
  index,
  selected,
  onClick,
  onContextMenu,
}: {
  frame: WebviewFrame;
  index: number;
  selected: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const thumbSize = 56;
    canvas.width = thumbSize;
    canvas.height = thumbSize;

    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, thumbSize, thumbSize);

    const imgData = frameToImageData(frame);
    if (!imgData) return;

    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = frame.width;
    tmpCanvas.height = frame.height;
    tmpCanvas.getContext("2d")!.putImageData(imgData, 0, 0);

    // Scale to fit thumbnail
    const scale = Math.min(thumbSize / frame.width, thumbSize / frame.height);
    const w = frame.width * scale;
    const h = frame.height * scale;
    ctx.drawImage(tmpCanvas, (thumbSize - w) / 2, (thumbSize - h) / 2, w, h);
  }, [frame]);

  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{
        flexShrink: 0,
        cursor: "pointer",
        border: `2px solid ${selected ? "var(--vscode-focusBorder)" : "transparent"}`,
        borderRadius: "2px",
        position: "relative",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "56px",
          height: "56px",
          imageRendering: "pixelated",
          display: "block",
        }}
      />
      <span
        style={{
          position: "absolute",
          bottom: "1px",
          right: "2px",
          fontSize: "0.6em",
          color: "var(--vscode-descriptionForeground)",
          background: "rgba(0,0,0,0.6)",
          padding: "0 2px",
        }}
      >
        {index}
      </span>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "var(--vscode-button-background)",
  color: "var(--vscode-button-foreground)",
  border: "none",
  padding: "3px 10px",
  cursor: "pointer",
  borderRadius: "2px",
};

const btnSecondaryStyle: React.CSSProperties = {
  background: "var(--vscode-button-secondaryBackground)",
  color: "var(--vscode-button-secondaryForeground)",
  border: "none",
  padding: "3px 10px",
  cursor: "pointer",
  borderRadius: "2px",
};
