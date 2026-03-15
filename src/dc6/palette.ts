/**
 * Palette management for DC6 files.
 *
 * D2 palettes are 256-color, stored as 256 × 3 bytes (R, G, B).
 * Each act has its own palette, plus there are UI-specific palettes.
 */

export interface Palette {
  name: string;
  colors: Uint8Array; // 256 × 4 (RGBA)
}

/**
 * Path patterns for auto-detecting which palette to use.
 * Matched against the file's path within the MPQ.
 */
const PALETTE_PATH_RULES: Array<{ pattern: RegExp; palette: string }> = [
  { pattern: /data[/\\]global[/\\]ui/i, palette: "act1" },
  { pattern: /data[/\\]global[/\\]chars/i, palette: "act1" },
  { pattern: /data[/\\]global[/\\]items/i, palette: "act1" },
  { pattern: /data[/\\]global[/\\]monsters/i, palette: "act1" },
  { pattern: /data[/\\]local[/\\]font/i, palette: "act1" },
  { pattern: /act1/i, palette: "act1" },
  { pattern: /act2/i, palette: "act2" },
  { pattern: /act3/i, palette: "act3" },
  { pattern: /act4/i, palette: "act4" },
  { pattern: /act5/i, palette: "act5" },
];

/**
 * Auto-detect the appropriate palette for a file based on its path.
 */
export function detectPalette(filePath: string): string {
  for (const rule of PALETTE_PATH_RULES) {
    if (rule.pattern.test(filePath)) {
      return rule.palette;
    }
  }
  return "act1"; // Default fallback
}

/**
 * Parse a D2 palette file (.dat format).
 * Each palette is 256 colors × 3 bytes (R, G, B) = 768 bytes.
 */
export function parsePalette(data: Uint8Array, name: string): Palette {
  const colors = new Uint8Array(256 * 4);

  for (let i = 0; i < 256; i++) {
    // D2 palette .dat files store colors as B, G, R
    colors[i * 4 + 0] = data[i * 3 + 2]; // R
    colors[i * 4 + 1] = data[i * 3 + 1]; // G
    colors[i * 4 + 2] = data[i * 3 + 0]; // B
    colors[i * 4 + 3] = i === 0 ? 0 : 255; // A (index 0 = transparent)
  }

  return { name, colors };
}

/**
 * Apply a palette to palette-indexed pixels, producing RGBA output.
 */
export function applyPalette(
  indices: Uint8Array,
  palette: Palette
): Uint8Array {
  const rgba = new Uint8Array(indices.length * 4);

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    rgba[i * 4 + 0] = palette.colors[idx * 4 + 0];
    rgba[i * 4 + 1] = palette.colors[idx * 4 + 1];
    rgba[i * 4 + 2] = palette.colors[idx * 4 + 2];
    rgba[i * 4 + 3] = palette.colors[idx * 4 + 3];
  }

  return rgba;
}

/**
 * Reverse palette lookup — find the closest palette index for an RGB color.
 * Used when importing edited PNGs back to palette-indexed DC6.
 */
export function findClosestPaletteIndex(
  r: number,
  g: number,
  b: number,
  a: number,
  palette: Palette
): number {
  // Transparent pixels → index 0
  if (a < 128) {
    return 0;
  }

  let bestIndex = 1; // Skip transparent index 0
  let bestDist = Infinity;

  for (let i = 1; i < 256; i++) {
    const pr = palette.colors[i * 4 + 0];
    const pg = palette.colors[i * 4 + 1];
    const pb = palette.colors[i * 4 + 2];

    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const dist = dr * dr + dg * dg + db * db;

    if (dist === 0) {
      return i; // Exact match
    }
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }

  return bestIndex;
}
