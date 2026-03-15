import React, { useCallback, useEffect, useRef, useState } from "react";
import { onMessage, postMessage } from "../shared/vscode-api";

interface LayerFrame {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  rgbaBase64: string;
}

interface LayerData {
  type: number;
  typeName: string;
  found: boolean;
  path: string;
  frames: LayerFrame[][];  // [direction][frame]
}

interface COFData {
  cof: {
    numberOfLayers: number;
    framesPerDirection: number;
    numberOfDirections: number;
    speed: number;
    layers: Array<{
      type: number;
      typeName: string;
      shadow: number;
      selectable: boolean;
      transparent: boolean;
      drawEffect: number;
      weaponClass: string;
    }>;
  };
  layers: LayerData[];
  context: {
    token: string;
    animMode: string;
    weaponClass: string;
    basePath: string;
  };
}

function frameToImageData(frame: LayerFrame): ImageData | null {
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

export function COFViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<COFData | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState(0);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [zoom, setZoom] = useState(2);
  const [layerVisibility, setLayerVisibility] = useState<boolean[]>([]);

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === "load") {
        setFileName(msg.fileName as string);
        setError(msg.error as string | null);
        if (msg.data) {
          const d = msg.data as COFData;
          setData(d);
          setLayerVisibility(d.layers.map(() => true));
        }
      }
    });
    postMessage({ type: "ready" });
    return cleanup;
  }, []);

  // Animation playback
  useEffect(() => {
    if (!playing || !data) return;
    const fps = (25 * data.cof.speed) / 256;
    const interval = fps > 0 ? 1000 / fps : 100;
    const timer = setInterval(() => {
      setCurrentFrame(prev => (prev + 1) % data.cof.framesPerDirection);
    }, interval);
    return () => clearInterval(timer);
  }, [playing, data]);

  // Render composite frame
  useEffect(() => {
    if (!canvasRef.current || !data) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Calculate bounding box across all visible layers for this direction/frame
    let minX = 0, minY = 0, maxX = 64, maxY = 64;
    for (let i = 0; i < data.layers.length; i++) {
      if (!layerVisibility[i] || !data.layers[i].found) continue;
      const dirFrames = data.layers[i].frames[direction];
      if (!dirFrames || currentFrame >= dirFrames.length) continue;
      const frame = dirFrames[currentFrame];
      const left = frame.offsetX;
      const top = -frame.offsetY;
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, left + frame.width);
      maxY = Math.max(maxY, top + frame.height);
    }

    const w = maxX - minX;
    const h = maxY - minY;
    canvas.width = w * zoom;
    canvas.height = h * zoom;

    // Checkerboard background
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

    // Draw layers in order
    for (let i = 0; i < data.layers.length; i++) {
      if (!layerVisibility[i] || !data.layers[i].found) continue;
      const dirFrames = data.layers[i].frames[direction];
      if (!dirFrames || currentFrame >= dirFrames.length) continue;

      const frame = dirFrames[currentFrame];
      const imgData = frameToImageData(frame);
      if (!imgData) continue;

      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = frame.width;
      tmpCanvas.height = frame.height;
      tmpCanvas.getContext("2d")!.putImageData(imgData, 0, 0);

      const drawX = (frame.offsetX - minX) * zoom;
      const drawY = (-frame.offsetY - minY) * zoom;
      ctx.drawImage(tmpCanvas, drawX, drawY, frame.width * zoom, frame.height * zoom);
    }
  }, [data, direction, currentFrame, zoom, layerVisibility]);

  if (error) {
    return (
      <div style={{ padding: 20, color: "var(--vscode-errorForeground)" }}>
        Failed to load COF: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--vscode-descriptionForeground)" }}>
        Loading COF...
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", outline: "none" }}>
      {/* Toolbar */}
      <div style={{
        padding: "6px 12px",
        borderBottom: "1px solid var(--vscode-panel-border)",
        display: "flex", alignItems: "center", gap: "12px",
        flexShrink: 0, fontSize: "0.9em",
      }}>
        <span style={{ fontWeight: "bold" }}>{fileName}</span>
        <span style={{ color: "var(--vscode-descriptionForeground)" }}>
          {data.cof.numberOfLayers} layers | {data.cof.framesPerDirection} frames | {data.cof.numberOfDirections} dirs
        </span>
        <span style={{ color: "var(--vscode-descriptionForeground)" }}>
          Speed: {data.cof.speed} ({((25 * data.cof.speed) / 256).toFixed(1)} fps)
        </span>

        {/* Direction selector */}
        <select
          value={direction}
          onChange={e => setDirection(Number(e.target.value))}
          style={{
            background: "var(--vscode-dropdown-background)",
            color: "var(--vscode-dropdown-foreground)",
            border: "1px solid var(--vscode-dropdown-border)",
            padding: "2px 8px",
          }}
        >
          {Array.from({ length: data.cof.numberOfDirections }, (_, i) => (
            <option key={i} value={i}>Direction {i}</option>
          ))}
        </select>

        <button onClick={() => setPlaying(!playing)} style={btnStyle}>
          {playing ? "Pause" : "Play"}
        </button>
        <span style={{ color: "var(--vscode-descriptionForeground)" }}>
          {currentFrame + 1}/{data.cof.framesPerDirection}
        </span>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px" }}>
          <span>Zoom:</span>
          <input type="range" min="1" max="8" value={zoom} onChange={e => setZoom(Number(e.target.value))} style={{ width: "80px" }} />
          <span>{zoom}x</span>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Canvas */}
        <div style={{
          flex: 1, overflow: "auto", display: "flex",
          alignItems: "center", justifyContent: "center",
          background: "#1a1a1a",
        }}>
          <canvas ref={canvasRef} style={{ imageRendering: "pixelated", border: "1px solid var(--vscode-panel-border)" }} />
        </div>

        {/* Layer panel */}
        <div style={{
          width: "220px", flexShrink: 0,
          borderLeft: "1px solid var(--vscode-panel-border)",
          overflow: "auto", padding: "8px",
          background: "var(--vscode-sideBar-background)",
        }}>
          <div style={{ fontWeight: "bold", marginBottom: "8px", fontSize: "0.85em" }}>Layers</div>
          {data.layers.map((layer, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: "6px",
              padding: "4px", marginBottom: "2px", borderRadius: "3px",
              background: layerVisibility[i] ? "var(--vscode-list-hoverBackground)" : "transparent",
              opacity: layer.found ? 1 : 0.4,
            }}>
              <input
                type="checkbox"
                checked={layerVisibility[i]}
                disabled={!layer.found}
                onChange={() => {
                  const next = [...layerVisibility];
                  next[i] = !next[i];
                  setLayerVisibility(next);
                }}
              />
              <div style={{ flex: 1, fontSize: "0.8em" }}>
                <div style={{ fontWeight: "bold" }}>{layer.typeName}</div>
                <div style={{ color: "var(--vscode-descriptionForeground)", fontSize: "0.85em" }}>
                  {layer.found ? layer.path.split("/").pop() : "Not found"}
                </div>
              </div>
            </div>
          ))}

          {/* Context info */}
          <div style={{ marginTop: "16px", borderTop: "1px solid var(--vscode-panel-border)", paddingTop: "8px", fontSize: "0.75em", color: "var(--vscode-descriptionForeground)" }}>
            <div>Token: {data.context.token}</div>
            <div>Mode: {data.context.animMode}</div>
            <div>Weapon: {data.context.weaponClass}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "var(--vscode-button-background)",
  color: "var(--vscode-button-foreground)",
  border: "none", padding: "3px 10px",
  cursor: "pointer", borderRadius: "2px",
};
