/**
 * DT1 (Diablo Tile) file format parser.
 *
 * DT1 files contain isometric map tiles used for floors, walls, roofs,
 * shadows, and special tiles. Each tile contains multiple blocks that
 * are either isometrically encoded (floors) or RLE encoded (walls).
 *
 * Based on the OpenDiablo2 reference implementation.
 */

export interface SubTileFlags {
  blockWalk: boolean;
  blockLOS: boolean;
  blockJump: boolean;
  blockPlayerWalk: boolean;
  blockLight: boolean;
}

export interface MaterialFlags {
  other: boolean;
  water: boolean;
  woodObject: boolean;
  insideStone: boolean;
  outsideStone: boolean;
  dirt: boolean;
  sand: boolean;
  wood: boolean;
  lava: boolean;
  snow: boolean;
}

export interface DT1Block {
  x: number;
  y: number;
  gridX: number;
  gridY: number;
  format: number; // 0 = RLE, 1 = Isometric
  length: number;
  fileOffset: number;
  encodedData: Uint8Array;
}

/** Tile orientation names */
export const TILE_ORIENTATIONS: Record<number, string> = {
  0: "Floor", 1: "Left Wall", 2: "Right Wall", 3: "NW Corner",
  4: "Left Part", 5: "Right Part", 6: "NE Corner", 7: "SW Corner",
  8: "SE Corner", 9: "Column", 10: "Special 1", 11: "Special 2",
  13: "Shadow", 14: "Tree/Object", 15: "Roof",
  16: "Lower Left Wall", 17: "Lower Right Wall",
  18: "Lower NW Corner", 19: "Lower NE Corner",
};

export interface DT1Tile {
  direction: number;
  roofHeight: number;
  materialFlags: MaterialFlags;
  height: number;
  width: number;
  type: number;
  style: number;
  sequence: number;
  rarityFrameIndex: number;
  subTileFlags: SubTileFlags[];
  blocks: DT1Block[];
}

export interface DT1File {
  majorVersion: number;
  minorVersion: number;
  tiles: DT1Tile[];
}

/**
 * Parse a DT1 file from binary data.
 */
export function parseDT1(data: Uint8Array): DT1File {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const majorVersion = view.getInt32(offset, true); offset += 4;
  const minorVersion = view.getInt32(offset, true); offset += 4;

  // Skip 260 unknown header bytes
  offset += 260;

  const numberOfTiles = view.getInt32(offset, true); offset += 4;
  const bodyPosition = view.getInt32(offset, true); offset += 4;

  // Only version 7.6 is fully supported. Other versions have different header layouts.
  if (majorVersion !== 7 || minorVersion !== 6) {
    console.warn(`[DT1] Unsupported version ${majorVersion}.${minorVersion} (only 7.6 is supported)`);
    return { majorVersion, minorVersion, tiles: [] };
  }

  // Seek to body
  offset = bodyPosition;

  const tiles: DT1Tile[] = [];

  // Read tile headers (96 bytes each)
  for (let i = 0; i < numberOfTiles; i++) {
    if (offset + 96 > data.length) break;
    const direction = view.getInt32(offset, true); offset += 4;
    const roofHeight = view.getInt16(offset, true); offset += 2;
    const matFlagBits = view.getUint16(offset, true); offset += 2;
    const height = view.getInt32(offset, true); offset += 4;
    const width = view.getInt32(offset, true); offset += 4;
    offset += 4; // unknown1
    const type = view.getInt32(offset, true); offset += 4;
    const style = view.getInt32(offset, true); offset += 4;
    const sequence = view.getInt32(offset, true); offset += 4;
    const rarityFrameIndex = view.getInt32(offset, true); offset += 4;
    offset += 4; // unknown2

    const subTileFlags: SubTileFlags[] = [];
    for (let s = 0; s < 25; s++) {
      const b = data[offset++];
      subTileFlags.push({
        blockWalk: (b & 1) !== 0,
        blockLOS: (b & 2) !== 0,
        blockJump: (b & 4) !== 0,
        blockPlayerWalk: (b & 8) !== 0,
        blockLight: (b & 32) !== 0,
      });
    }

    offset += 7; // unknown3
    const blockHeaderPointer = view.getInt32(offset, true); offset += 4;
    const blockHeaderSize = view.getInt32(offset, true); offset += 4;
    const numBlocks = view.getInt32(offset, true); offset += 4;
    offset += 12; // unknown4

    tiles.push({
      direction, roofHeight, height, width, type, style, sequence, rarityFrameIndex,
      materialFlags: decodeMaterialFlags(matFlagBits),
      subTileFlags,
      blocks: new Array(numBlocks),
    });

    // Store block pointer for second pass
    (tiles[i] as any)._blockPtr = blockHeaderPointer;
  }

  // Read block headers and data
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const blockPtr = (tile as any)._blockPtr as number;
    delete (tile as any)._blockPtr;

    // Validate block pointer is within file bounds
    if (blockPtr < 0 || blockPtr >= data.length) {
      tile.blocks = [];
      continue;
    }

    let bOffset = blockPtr;
    const blockHeaderEnd = bOffset + tile.blocks.length * 20; // 20 bytes per block header
    if (blockHeaderEnd > data.length) {
      tile.blocks = [];
      continue;
    }

    for (let b = 0; b < tile.blocks.length; b++) {
      if (bOffset + 20 > data.length) {
        tile.blocks = tile.blocks.slice(0, b);
        break;
      }
      const x = view.getInt16(bOffset, true); bOffset += 2;
      const y = view.getInt16(bOffset, true); bOffset += 2;
      bOffset += 2; // unknown
      const gridX = data[bOffset++];
      const gridY = data[bOffset++];
      const format = view.getInt16(bOffset, true); bOffset += 2;
      const length = view.getInt32(bOffset, true); bOffset += 4;
      bOffset += 2; // unknown
      const fileOffset = view.getInt32(bOffset, true); bOffset += 4;

      tile.blocks[b] = { x, y, gridX, gridY, format, length, fileOffset, encodedData: new Uint8Array(0) };
    }

    // Read block encoded data
    for (let b = 0; b < tile.blocks.length; b++) {
      const block = tile.blocks[b];
      const dataStart = blockPtr + block.fileOffset;
      if (dataStart < 0 || dataStart + block.length > data.length) {
        block.encodedData = new Uint8Array(0);
        continue;
      }
      block.encodedData = data.slice(dataStart, dataStart + block.length);
    }
  }

  return { majorVersion, minorVersion, tiles };
}

/**
 * Decode tile graphics into a pixel buffer (palette indices).
 * Returns pixels in a buffer of size tileWidth * tileHeight.
 */
export function decodeTileGfx(
  blocks: DT1Block[],
  tileWidth: number,
  tileHeight: number,
  tileYOffset?: number
): Uint8Array {
  const absHeight = Math.abs(tileHeight);
  const pixels = new Uint8Array(tileWidth * absHeight);

  // Auto-compute Y offset from blocks if not provided.
  // Wall blocks have negative Y values — offset them so they start at 0.
  if (tileYOffset === undefined) {
    let minBlockY = 0;
    for (const block of blocks) {
      minBlockY = Math.min(minBlockY, block.y);
    }
    tileYOffset = -minBlockY;
  }

  for (const block of blocks) {
    if (block.format === 1) {
      // Isometric floor encoding (256 bytes, diamond shape)
      const xjump = [14, 12, 10, 8, 6, 4, 2, 0, 2, 4, 6, 8, 10, 12, 14];
      const nbpix = [4, 8, 12, 16, 20, 24, 28, 32, 28, 24, 20, 16, 12, 8, 4];

      let idx = 0;
      for (let y = 0; y < 15; y++) {
        let x = xjump[y];
        let n = nbpix[y];

        for (let p = 0; p < n; p++) {
          const px = block.x + x + p;
          const py = block.y + y + tileYOffset;
          if (px >= 0 && px < tileWidth && py >= 0 && py < absHeight) {
            pixels[py * tileWidth + px] = block.encodedData[idx];
          }
          idx++;
        }
      }
    } else {
      // RLE encoding (skip/draw pairs)
      let x = 0;
      let y = 0;
      let idx = 0;
      let length = block.length;

      while (length > 0 && idx + 1 < block.encodedData.length) {
        const b1 = block.encodedData[idx];     // skip
        const b2 = block.encodedData[idx + 1]; // draw count
        idx += 2;
        length -= 2;

        if (b1 === 0 && b2 === 0) {
          x = 0;
          y++;
          continue;
        }

        x += b1;
        length -= b2;

        for (let p = 0; p < b2 && idx < block.encodedData.length; p++) {
          const px = block.x + x;
          const py = block.y + y + tileYOffset;
          if (px >= 0 && px < tileWidth && py >= 0 && py < absHeight) {
            pixels[py * tileWidth + px] = block.encodedData[idx];
          }
          idx++;
          x++;
        }
      }
    }
  }

  return pixels;
}

function decodeMaterialFlags(bits: number): MaterialFlags {
  return {
    other: (bits & 0x0001) !== 0,
    water: (bits & 0x0002) !== 0,
    woodObject: (bits & 0x0004) !== 0,
    insideStone: (bits & 0x0008) !== 0,
    outsideStone: (bits & 0x0010) !== 0,
    dirt: (bits & 0x0020) !== 0,
    sand: (bits & 0x0040) !== 0,
    wood: (bits & 0x0080) !== 0,
    lava: (bits & 0x0100) !== 0,
    snow: (bits & 0x0400) !== 0,
  };
}

/**
 * Compute the tight bounding box of non-transparent pixels in a decoded tile.
 * Returns the cropped region and pixel data.
 */
export function cropTileGfx(
  pixels: Uint8Array,
  width: number,
  height: number
): { pixels: Uint8Array; x: number; y: number; width: number; height: number } {
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let hasPixels = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] !== 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + 1);
        maxY = Math.max(maxY, y + 1);
        hasPixels = true;
      }
    }
  }

  if (!hasPixels) {
    return { pixels: new Uint8Array(1), x: 0, y: 0, width: 1, height: 1 };
  }

  const cropW = maxX - minX;
  const cropH = maxY - minY;
  const cropped = new Uint8Array(cropW * cropH);

  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      cropped[y * cropW + x] = pixels[(y + minY) * width + (x + minX)];
    }
  }

  return { pixels: cropped, x: minX, y: minY, width: cropW, height: cropH };
}

export function isDT1File(data: Uint8Array): boolean {
  if (data.length < 276) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getInt32(0, true) === 7 && view.getInt32(4, true) === 6;
}
