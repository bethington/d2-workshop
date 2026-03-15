import { DC6Frame } from "./dc6-parser";
import { Palette, applyPalette } from "./palette";

/**
 * Companion JSON layout for a DC6 file.
 * Persisted in .d2workshop/dc6/ and used for composite image generation.
 */
export interface DC6CompanionLayout {
  /** Source DC6 file path */
  source: string;
  /** Palette used for rendering */
  palette: string;
  /** Display mode */
  displayMode: "composite" | "animation" | "button";
  /** Animation speed in ms per frame (if animation mode) */
  animationSpeed: number;
  /** Zoom level */
  zoom: number;
  /** Canvas dimensions */
  canvasWidth: number;
  canvasHeight: number;
  /** Per-frame layout positions */
  frames: FrameLayout[];
}

export interface FrameLayout {
  /** Position on composite canvas */
  canvasX: number;
  canvasY: number;
  /** Frame dimensions */
  width: number;
  height: number;
  /** DC6 metadata */
  direction: number;
  frameIndex: number;
  /** DC6 offsets (for game rendering) */
  offsetX: number;
  offsetY: number;
}

/**
 * Generate a default grid layout for DC6 frames.
 * Arranges frames in as square a grid as possible.
 */
export function generateGridLayout(
  frames: DC6Frame[],
  sourcePath: string,
  paletteName: string
): DC6CompanionLayout {
  if (frames.length === 0) {
    return {
      source: sourcePath,
      palette: paletteName,
      displayMode: "composite",
      animationSpeed: 100,
      zoom: 1,
      canvasWidth: 0,
      canvasHeight: 0,
      frames: [],
    };
  }

  // Calculate grid dimensions (as close to square as possible)
  const cols = Math.ceil(Math.sqrt(frames.length));

  // Find max frame dimensions for uniform cell sizing
  let maxWidth = 0;
  let maxHeight = 0;
  for (const frame of frames) {
    maxWidth = Math.max(maxWidth, frame.width);
    maxHeight = Math.max(maxHeight, frame.height);
  }

  const cellWidth = maxWidth;
  const cellHeight = maxHeight;

  const frameLayouts: FrameLayout[] = frames.map((frame, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);

    return {
      canvasX: col * cellWidth,
      canvasY: row * cellHeight,
      width: frame.width,
      height: frame.height,
      direction: frame.direction,
      frameIndex: frame.frameIndex,
      offsetX: frame.offsetX,
      offsetY: frame.offsetY,
    };
  });

  return {
    source: sourcePath,
    palette: paletteName,
    displayMode: "composite",
    animationSpeed: 100,
    zoom: 1,
    ...fitCanvasToFrames(frameLayouts),
    frames: frameLayouts,
  };
}

/**
 * Calculate the tight bounding box canvas dimensions for a set of frame layouts.
 * Returns the minimum canvasWidth/canvasHeight needed to contain all frames.
 */
export function fitCanvasToFrames(
  frames: FrameLayout[]
): { canvasWidth: number; canvasHeight: number } {
  if (frames.length === 0) {
    return { canvasWidth: 0, canvasHeight: 0 };
  }

  let maxRight = 0;
  let maxBottom = 0;
  for (const fl of frames) {
    maxRight = Math.max(maxRight, fl.canvasX + fl.width);
    maxBottom = Math.max(maxBottom, fl.canvasY + fl.height);
  }

  return { canvasWidth: maxRight, canvasHeight: maxBottom };
}

/**
 * Render frames onto a composite RGBA canvas using the layout.
 */
export function renderComposite(
  frames: DC6Frame[],
  layout: DC6CompanionLayout,
  palette: Palette
): Uint8Array {
  const canvas = new Uint8Array(layout.canvasWidth * layout.canvasHeight * 4);

  for (let i = 0; i < frames.length && i < layout.frames.length; i++) {
    const frame = frames[i];
    const fl = layout.frames[i];

    // Convert palette indices to RGBA
    const rgba = applyPalette(frame.pixels, palette);

    // Blit frame onto canvas at layout position
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const srcIdx = (y * frame.width + x) * 4;
        const dstX = fl.canvasX + x;
        const dstY = fl.canvasY + y;

        if (
          dstX < 0 ||
          dstX >= layout.canvasWidth ||
          dstY < 0 ||
          dstY >= layout.canvasHeight
        ) {
          continue;
        }

        const dstIdx = (dstY * layout.canvasWidth + dstX) * 4;

        // Only write non-transparent pixels
        if (rgba[srcIdx + 3] > 0) {
          canvas[dstIdx + 0] = rgba[srcIdx + 0];
          canvas[dstIdx + 1] = rgba[srcIdx + 1];
          canvas[dstIdx + 2] = rgba[srcIdx + 2];
          canvas[dstIdx + 3] = rgba[srcIdx + 3];
        }
      }
    }
  }

  return canvas;
}

/**
 * Slice a composite RGBA image back into individual frame pixel arrays
 * using the layout coordinates. Returns palette indices.
 */
export function sliceComposite(
  compositeRgba: Uint8Array,
  compositeWidth: number,
  layout: DC6CompanionLayout,
  palette: Palette
): Uint8Array[] {
  const { findClosestPaletteIndex } = require("./palette");
  const framePixels: Uint8Array[] = [];

  for (const fl of layout.frames) {
    const pixels = new Uint8Array(fl.width * fl.height);

    for (let y = 0; y < fl.height; y++) {
      for (let x = 0; x < fl.width; x++) {
        const srcX = fl.canvasX + x;
        const srcY = fl.canvasY + y;
        const srcIdx = (srcY * compositeWidth + srcX) * 4;

        const r = compositeRgba[srcIdx + 0];
        const g = compositeRgba[srcIdx + 1];
        const b = compositeRgba[srcIdx + 2];
        const a = compositeRgba[srcIdx + 3];

        pixels[y * fl.width + x] = findClosestPaletteIndex(
          r,
          g,
          b,
          a,
          palette
        );
      }
    }

    framePixels.push(pixels);
  }

  return framePixels;
}
