/**
 * PL2 (Palette Transform) file format parser for Diablo II.
 *
 * PL2 files contain the base palette plus all color transforms used
 * in the game: light levels, poison/cold tints, item quality colors,
 * alpha blending tables, hue variations, and text colors.
 *
 * The file is a fixed-size (~443KB) flat binary structure.
 */

export interface PL2Color {
  r: number;
  g: number;
  b: number;
}

/** 256-entry palette (RGBA, 4 bytes per color, padding byte ignored) */
export interface PL2Palette {
  colors: PL2Color[];
}

/** 256-entry index transform (maps original palette index to new index) */
export interface PL2PaletteTransform {
  indices: Uint8Array;
}

export interface PL2File {
  basePalette: PL2Palette;
  /** 32 light level variations (0=darkest, 31=brightest) */
  lightLevelVariations: PL2PaletteTransform[];
  /** 16 inventory color variations */
  invColorVariations: PL2PaletteTransform[];
  /** Selected unit highlight shift */
  selectedUnitShift: PL2PaletteTransform;
  /** Alpha blend tables [3][256] */
  alphaBlend: PL2PaletteTransform[][];
  /** Additive blend tables [256] */
  additiveBlend: PL2PaletteTransform[];
  /** Multiplicative blend tables [256] */
  multiplicativeBlend: PL2PaletteTransform[];
  /** 111 hue variation transforms */
  hueVariations: PL2PaletteTransform[];
  /** Red/Green/Blue tone transforms */
  redTones: PL2PaletteTransform;
  greenTones: PL2PaletteTransform;
  blueTones: PL2PaletteTransform;
  /** 14 unknown variation transforms */
  unknownVariations: PL2PaletteTransform[];
  /** Max component blend tables [256] */
  maxComponentBlend: PL2PaletteTransform[];
  /** Darkened color shift transform */
  darkenedColorShift: PL2PaletteTransform;
  /** 13 text colors (RGB) for item quality, chat, etc. */
  textColors: PL2Color[];
  /** 13 text color shift transforms */
  textColorShifts: PL2PaletteTransform[];
}

/** Text color names in Diablo II */
export const TEXT_COLOR_NAMES: string[] = [
  "White", "Red", "Green", "Blue", "Gold",
  "Dark Gray", "Black", "Tan", "Orange", "Yellow",
  "Dark Green", "Purple", "Dark Red",
];

function readPalette(data: Uint8Array, offset: number): { palette: PL2Palette; offset: number } {
  const colors: PL2Color[] = [];
  for (let i = 0; i < 256; i++) {
    colors.push({
      r: data[offset],
      g: data[offset + 1],
      b: data[offset + 2],
    });
    offset += 4; // 4th byte is padding
  }
  return { palette: { colors }, offset };
}

function readTransform(data: Uint8Array, offset: number): { transform: PL2PaletteTransform; offset: number } {
  const indices = data.slice(offset, offset + 256);
  return { transform: { indices: new Uint8Array(indices) }, offset: offset + 256 };
}

function readTransforms(data: Uint8Array, offset: number, count: number): { transforms: PL2PaletteTransform[]; offset: number } {
  const transforms: PL2PaletteTransform[] = [];
  for (let i = 0; i < count; i++) {
    const result = readTransform(data, offset);
    transforms.push(result.transform);
    offset = result.offset;
  }
  return { transforms, offset };
}

/**
 * Parse a PL2 file from binary data.
 */
export function parsePL2(data: Uint8Array): PL2File {
  let offset = 0;

  // Base palette: 256 colors × 4 bytes = 1024 bytes
  const { palette: basePalette, offset: o1 } = readPalette(data, offset);
  offset = o1;

  // Light level variations: 32 × 256 = 8,192 bytes
  const { transforms: lightLevelVariations, offset: o2 } = readTransforms(data, offset, 32);
  offset = o2;

  // Inv color variations: 16 × 256 = 4,096 bytes
  const { transforms: invColorVariations, offset: o3 } = readTransforms(data, offset, 16);
  offset = o3;

  // Selected unit shift: 256 bytes
  const { transform: selectedUnitShift, offset: o4 } = readTransform(data, offset);
  offset = o4;

  // Alpha blend: 3 × 256 × 256 = 196,608 bytes
  const alphaBlend: PL2PaletteTransform[][] = [];
  for (let i = 0; i < 3; i++) {
    const { transforms, offset: next } = readTransforms(data, offset, 256);
    alphaBlend.push(transforms);
    offset = next;
  }

  // Additive blend: 256 × 256 = 65,536 bytes
  const { transforms: additiveBlend, offset: o5 } = readTransforms(data, offset, 256);
  offset = o5;

  // Multiplicative blend: 256 × 256 = 65,536 bytes
  const { transforms: multiplicativeBlend, offset: o6 } = readTransforms(data, offset, 256);
  offset = o6;

  // Hue variations: 111 × 256 = 28,416 bytes
  const { transforms: hueVariations, offset: o7 } = readTransforms(data, offset, 111);
  offset = o7;

  // Red/Green/Blue tones: 3 × 256 = 768 bytes
  const { transform: redTones, offset: o8 } = readTransform(data, offset);
  offset = o8;
  const { transform: greenTones, offset: o9 } = readTransform(data, offset);
  offset = o9;
  const { transform: blueTones, offset: o10 } = readTransform(data, offset);
  offset = o10;

  // Unknown variations: 14 × 256 = 3,584 bytes
  const { transforms: unknownVariations, offset: o11 } = readTransforms(data, offset, 14);
  offset = o11;

  // Max component blend: 256 × 256 = 65,536 bytes
  const { transforms: maxComponentBlend, offset: o12 } = readTransforms(data, offset, 256);
  offset = o12;

  // Darkened color shift: 256 bytes
  const { transform: darkenedColorShift, offset: o13 } = readTransform(data, offset);
  offset = o13;

  // Text colors: 13 × 3 bytes = 39 bytes
  const textColors: PL2Color[] = [];
  for (let i = 0; i < 13; i++) {
    textColors.push({ r: data[offset], g: data[offset + 1], b: data[offset + 2] });
    offset += 3;
  }

  // Text color shifts: 13 × 256 = 3,328 bytes
  const { transforms: textColorShifts, offset: o14 } = readTransforms(data, offset, 13);
  offset = o14;

  return {
    basePalette, lightLevelVariations, invColorVariations,
    selectedUnitShift, alphaBlend, additiveBlend, multiplicativeBlend,
    hueVariations, redTones, greenTones, blueTones,
    unknownVariations, maxComponentBlend, darkenedColorShift,
    textColors, textColorShifts,
  };
}

/**
 * Apply a palette transform to the base palette, producing a new 256-color palette.
 */
export function applyTransform(basePalette: PL2Palette, transform: PL2PaletteTransform): PL2Color[] {
  return Array.from(transform.indices).map(idx => basePalette.colors[idx] || { r: 0, g: 0, b: 0 });
}
