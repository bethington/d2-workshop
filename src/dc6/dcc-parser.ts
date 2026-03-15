/**
 * DCC (Diablo Compressed Codec) file format parser.
 *
 * Based on the OpenDiablo2 reference implementation.
 * DCC uses cell-based bitstream compression with a two-stage decode:
 *   Stage 1: Fill pixel buffer (4 values per cell, per frame)
 *   Stage 2: Construct frame pixels from the buffer
 */

import { DC6Frame, DC6Header, DC6File } from "./dc6-parser";

const BITS_WIDTH_TABLE = [0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 26, 28, 30, 32];
const PIXEL_MASK_LOOKUP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

class BitReader {
  private data: Uint8Array;
  private bitPos: number;
  private startBit: number;

  constructor(data: Uint8Array, startBit: number = 0) {
    this.data = data;
    this.bitPos = startBit;
    this.startBit = startBit;
  }

  get position(): number { return this.bitPos; }
  set position(p: number) { this.bitPos = p; }

  bitsRead(): number { return this.bitPos - this.startBit; }

  readBit(): number {
    const byteIdx = this.bitPos >> 3;
    const bitIdx = this.bitPos & 7;
    this.bitPos++;
    if (byteIdx >= this.data.length) return 0;
    return (this.data[byteIdx] >> bitIdx) & 1;
  }

  readBits(count: number): number {
    if (count === 0) return 0;
    let value = 0;
    for (let i = 0; i < count; i++) {
      value |= this.readBit() << i;
    }
    return value >>> 0; // ensure unsigned
  }

  readSigned(count: number): number {
    if (count === 0) return 0;
    const value = this.readBits(count);
    if (value & (1 << (count - 1))) {
      return value - (1 << count);
    }
    return value;
  }

  skipBits(count: number): void {
    this.bitPos += count;
  }

  copy(): BitReader {
    return new BitReader(this.data, this.bitPos);
  }
}

interface PixelBufferEntry {
  value: [number, number, number, number];
  frame: number;
  frameCellIndex: number;
}

interface DCCCell {
  width: number;
  height: number;
  xOffset: number;
  yOffset: number;
  lastWidth: number;
  lastHeight: number;
  lastXOffset: number;
  lastYOffset: number;
}

interface FrameInfo {
  width: number;
  height: number;
  xOffset: number;
  yOffset: number;
  codedBytes: number;
  bottomUp: boolean;
  boxLeft: number;
  boxTop: number;
  hCells: number;
  vCells: number;
  cells: Array<{ width: number; height: number; xOffset: number; yOffset: number }>;
}

export function parseDCC(data: Uint8Array): DC6File {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const signature = data[0];
  const version = data[1];
  const nDirections = data[2];
  const nFramesPerDir = view.getUint32(3, true);

  const dirOffsets: number[] = [];
  for (let d = 0; d < nDirections; d++) {
    dirOffsets.push(view.getUint32(15 + d * 4, true));
  }

  const header: DC6Header = {
    version, flags: 1, encoding: 0, termination: 0xEEEEEEEE,
    directions: nDirections, framesPerDirection: nFramesPerDir,
  };

  const allFrames: DC6Frame[] = [];
  for (let dir = 0; dir < nDirections; dir++) {
    const frames = decodeDirection(data, dirOffsets[dir], nFramesPerDir, dir);
    allFrames.push(...frames);
  }

  return { header, frames: allFrames };
}

function decodeDirection(data: Uint8Array, offset: number, nFrames: number, dirIdx: number): DC6Frame[] {
  const bm = new BitReader(data, offset * 8);

  // Direction header
  const outSizeCoded = bm.readBits(32);
  const compressionFlags = bm.readBits(2);
  const variable0Bits = BITS_WIDTH_TABLE[bm.readBits(4)];
  const widthBits = BITS_WIDTH_TABLE[bm.readBits(4)];
  const heightBits = BITS_WIDTH_TABLE[bm.readBits(4)];
  const xOffsetBits = BITS_WIDTH_TABLE[bm.readBits(4)];
  const yOffsetBits = BITS_WIDTH_TABLE[bm.readBits(4)];
  const optionalDataBits = BITS_WIDTH_TABLE[bm.readBits(4)];
  const codedBytesBits = BITS_WIDTH_TABLE[bm.readBits(4)];

  // Frame headers
  const frameInfos: FrameInfo[] = [];
  let minX = 100000, minY = 100000, maxX = -100000, maxY = -100000;

  for (let f = 0; f < nFrames; f++) {
    bm.readBits(variable0Bits); // variable0 (skip)
    const width = bm.readBits(widthBits);
    const height = bm.readBits(heightBits);
    const xOff = bm.readSigned(xOffsetBits);
    const yOff = bm.readSigned(yOffsetBits);
    const optBytes = bm.readBits(optionalDataBits);
    const codedBytes = bm.readBits(codedBytesBits);
    const bottomUp = bm.readBit() !== 0;

    const boxLeft = xOff;
    const boxTop = yOff - height + 1;

    minX = Math.min(minX, boxLeft);
    minY = Math.min(minY, boxTop);
    maxX = Math.max(maxX, boxLeft + width);
    maxY = Math.max(maxY, boxTop + height);

    frameInfos.push({
      width, height, xOffset: xOff, yOffset: yOff, codedBytes, bottomUp,
      boxLeft, boxTop, hCells: 0, vCells: 0, cells: [],
    });
  }

  // Skip optional data (panic in reference if present)
  // We just skip it
  for (const fi of frameInfos) {
    // optionalBytes was already read, no data to skip in bitstream
  }

  const dirBoxLeft = minX;
  const dirBoxTop = minY;
  const dirW = maxX - minX;
  const dirH = maxY - minY;

  if (dirW <= 0 || dirH <= 0) {
    return frameInfos.map((fi, i) => ({
      flip: 0, width: fi.width || 1, height: fi.height || 1,
      offsetX: fi.xOffset, offsetY: fi.yOffset, length: 0,
      direction: dirIdx, frameIndex: i,
      pixels: new Uint8Array((fi.width || 1) * (fi.height || 1)),
    }));
  }

  // Bitstream sizes
  let equalCellsSize = 0;
  if (compressionFlags & 0x2) {
    equalCellsSize = bm.readBits(20);
  }
  const pixelMaskSize = bm.readBits(20);
  let encodingTypeSize = 0;
  let rawPixelCodesSize = 0;
  if (compressionFlags & 0x1) {
    encodingTypeSize = bm.readBits(20);
    rawPixelCodesSize = bm.readBits(20);
  }

  // Palette entries (256-bit bitmap)
  const paletteEntries: number[] = [];
  for (let i = 0; i < 256; i++) {
    if (bm.readBit()) {
      paletteEntries.push(i);
    }
  }

  // Create separate bitstream readers
  const equalCellsBs = bm.copy();
  bm.skipBits(equalCellsSize);
  const pixelMaskBs = bm.copy();
  bm.skipBits(pixelMaskSize);
  const encodingTypeBs = bm.copy();
  bm.skipBits(encodingTypeSize);
  const rawPixelCodesBs = bm.copy();
  bm.skipBits(rawPixelCodesSize);
  const pixelCodeDisplacementBs = bm.copy();

  // Calculate direction cells
  const dirHCells = dirW <= 0 ? 1 : 1 + Math.floor((dirW - 1) / 4);
  const dirVCells = dirH <= 0 ? 1 : 1 + Math.floor((dirH - 1) / 4);

  const dirCells: DCCCell[] = [];
  const dirCellWidths: number[] = [];
  const dirCellHeights: number[] = [];

  if (dirHCells === 1) {
    dirCellWidths.push(dirW);
  } else {
    for (let i = 0; i < dirHCells - 1; i++) dirCellWidths.push(4);
    dirCellWidths.push(dirW - 4 * (dirHCells - 1));
  }

  if (dirVCells === 1) {
    dirCellHeights.push(dirH);
  } else {
    for (let i = 0; i < dirVCells - 1; i++) dirCellHeights.push(4);
    dirCellHeights.push(dirH - 4 * (dirVCells - 1));
  }

  let yOff = 0;
  for (let y = 0; y < dirVCells; y++) {
    let xOff = 0;
    for (let x = 0; x < dirHCells; x++) {
      dirCells.push({
        width: dirCellWidths[x], height: dirCellHeights[y],
        xOffset: xOff, yOffset: yOff,
        lastWidth: -1, lastHeight: -1, lastXOffset: 0, lastYOffset: 0,
      });
      xOff += 4;
    }
    yOff += 4;
  }

  // Calculate per-frame cells
  for (const fi of frameInfos) {
    const fLeft = fi.boxLeft - dirBoxLeft;
    const fTop = fi.boxTop - dirBoxTop;

    let w0 = 4 - (fLeft % 4);
    if (w0 > fi.width) w0 = fi.width;

    if (fi.width - w0 <= 1) {
      fi.hCells = 1;
    } else {
      const tmp = fi.width - w0 - 1;
      fi.hCells = 2 + Math.floor(tmp / 4);
      if (tmp % 4 === 0) fi.hCells--;
    }

    let h0 = 4 - (fTop % 4);
    if (h0 > fi.height) h0 = fi.height;

    if (fi.height - h0 <= 1) {
      fi.vCells = 1;
    } else {
      const tmp = fi.height - h0 - 1;
      fi.vCells = 2 + Math.floor(tmp / 4);
      if (tmp % 4 === 0) fi.vCells--;
    }

    const cw: number[] = [];
    if (fi.hCells === 1) {
      cw.push(fi.width);
    } else {
      cw.push(w0);
      for (let i = 1; i < fi.hCells - 1; i++) cw.push(4);
      cw.push(fi.width - w0 - 4 * (fi.hCells - 2));
    }

    const ch: number[] = [];
    if (fi.vCells === 1) {
      ch.push(fi.height);
    } else {
      ch.push(h0);
      for (let i = 1; i < fi.vCells - 1; i++) ch.push(4);
      ch.push(fi.height - h0 - 4 * (fi.vCells - 2));
    }

    let cyo = fTop;
    for (let y = 0; y < fi.vCells; y++) {
      let cxo = fLeft;
      for (let x = 0; x < fi.hCells; x++) {
        fi.cells.push({ width: cw[x], height: ch[y], xOffset: cxo, yOffset: cyo });
        cxo += cw[x];
      }
      cyo += ch[y];
    }
  }

  // Stage 1: Fill pixel buffer
  const totalFrameCells = frameInfos.reduce((sum, fi) => sum + fi.hCells * fi.vCells, 0);
  const pixelBuffer: PixelBufferEntry[] = [];
  for (let i = 0; i < totalFrameCells; i++) {
    pixelBuffer.push({ value: [0, 0, 0, 0], frame: -1, frameCellIndex: -1 });
  }

  const cellBuffer: (PixelBufferEntry | null)[] = new Array(dirHCells * dirVCells).fill(null);
  let pbIdx = -1;
  let lastPixel = 0;

  for (let frameIdx = 0; frameIdx < nFrames; frameIdx++) {
    const fi = frameInfos[frameIdx];
    const originCellX = Math.floor((fi.boxLeft - dirBoxLeft) / 4);
    const originCellY = Math.floor((fi.boxTop - dirBoxTop) / 4);

    for (let cellY = 0; cellY < fi.vCells; cellY++) {
      const currentCellY = cellY + originCellY;
      for (let cellX = 0; cellX < fi.hCells; cellX++) {
        const currentCell = originCellX + cellX + currentCellY * dirHCells;
        let nextCell = false;
        let pixelMask = 0;

        if (cellBuffer[currentCell] !== null) {
          if (equalCellsSize > 0) {
            if (equalCellsBs.readBit() !== 0) {
              nextCell = true;
            }
          }
          if (!nextCell) {
            pixelMask = pixelMaskBs.readBits(4);
          }
        } else {
          pixelMask = 0x0F;
        }

        if (nextCell) continue;

        const numberOfPixelBits = PIXEL_MASK_LOOKUP[pixelMask];
        let encodingType = 0;
        if (numberOfPixelBits !== 0 && encodingTypeSize > 0) {
          encodingType = encodingTypeBs.readBit();
        }

        const pixelStack: number[] = [0, 0, 0, 0];
        lastPixel = 0;
        let decodedPixel = 0;

        for (let i = 0; i < numberOfPixelBits; i++) {
          if (encodingType !== 0) {
            pixelStack[i] = rawPixelCodesBs.readBits(8);
          } else {
            pixelStack[i] = lastPixel;
            let disp = pixelCodeDisplacementBs.readBits(4);
            pixelStack[i] += disp;
            while (disp === 15) {
              disp = pixelCodeDisplacementBs.readBits(4);
              pixelStack[i] += disp;
            }
          }

          if (pixelStack[i] === lastPixel) {
            pixelStack[i] = 0;
            break;
          } else {
            lastPixel = pixelStack[i];
            decodedPixel++;
          }
        }

        const oldEntry = cellBuffer[currentCell];
        pbIdx++;

        let curIdx = decodedPixel - 1;
        for (let i = 0; i < 4; i++) {
          if (pixelMask & (1 << i)) {
            if (curIdx >= 0) {
              pixelBuffer[pbIdx].value[i] = pixelStack[curIdx];
              curIdx--;
            } else {
              pixelBuffer[pbIdx].value[i] = 0;
            }
          } else if (oldEntry) {
            pixelBuffer[pbIdx].value[i] = oldEntry.value[i];
          }
        }

        cellBuffer[currentCell] = pixelBuffer[pbIdx];
        pixelBuffer[pbIdx].frame = frameIdx;
        pixelBuffer[pbIdx].frameCellIndex = cellX + cellY * fi.hCells;
      }
    }
  }

  // Convert pixel buffer indices to palette entries
  for (let i = 0; i <= pbIdx; i++) {
    for (let x = 0; x < 4; x++) {
      const idx = pixelBuffer[i].value[x];
      pixelBuffer[i].value[x] = idx < paletteEntries.length ? paletteEntries[idx] : 0;
    }
  }

  // Stage 2: Generate frames
  const dirPixelData = new Uint8Array(dirW * dirH);
  let pbReadIdx = 0;

  // Reset direction cells
  for (const dc of dirCells) {
    dc.lastWidth = -1;
    dc.lastHeight = -1;
  }

  const results: DC6Frame[] = [];

  for (let frameIdx = 0; frameIdx < nFrames; frameIdx++) {
    const fi = frameInfos[frameIdx];
    const framePixelData = new Uint8Array(dirW * dirH);

    for (let c = 0; c < fi.cells.length; c++) {
      const cell = fi.cells[c];
      const cellX = Math.floor(cell.xOffset / 4);
      const cellY = Math.floor(cell.yOffset / 4);
      const cellIndex = cellX + cellY * dirHCells;
      const bufferCell = dirCells[cellIndex];
      const pbe = pixelBuffer[pbReadIdx];

      if (pbe.frame !== frameIdx || pbe.frameCellIndex !== c) {
        // EqualCell — copy from previous frame or clear
        if (cell.width !== bufferCell.lastWidth || cell.height !== bufferCell.lastHeight) {
          for (let y = 0; y < cell.height; y++) {
            for (let x = 0; x < cell.width; x++) {
              dirPixelData[x + cell.xOffset + (y + cell.yOffset) * dirW] = 0;
            }
          }
        } else {
          for (let y = 0; y < cell.height; y++) {
            for (let x = 0; x < cell.width; x++) {
              dirPixelData[x + cell.xOffset + (y + cell.yOffset) * dirW] =
                dirPixelData[x + bufferCell.lastXOffset + (y + bufferCell.lastYOffset) * dirW];
            }
          }
          for (let y = 0; y < cell.height; y++) {
            for (let x = 0; x < cell.width; x++) {
              framePixelData[x + cell.xOffset + (y + cell.yOffset) * dirW] =
                dirPixelData[x + cell.xOffset + (y + cell.yOffset) * dirW];
            }
          }
        }
      } else {
        // Decode pixels from buffer entry
        if (pbe.value[0] === pbe.value[1]) {
          // Solid fill
          for (let y = 0; y < cell.height; y++) {
            for (let x = 0; x < cell.width; x++) {
              dirPixelData[x + cell.xOffset + (y + cell.yOffset) * dirW] = pbe.value[0];
            }
          }
        } else {
          // Read per-pixel indices from displacement bitstream
          let bitsToRead = 1;
          if (pbe.value[1] !== pbe.value[2]) {
            bitsToRead = 2;
          }
          for (let y = 0; y < cell.height; y++) {
            for (let x = 0; x < cell.width; x++) {
              const palIdx = pixelCodeDisplacementBs.readBits(bitsToRead);
              dirPixelData[x + cell.xOffset + (y + cell.yOffset) * dirW] = pbe.value[palIdx];
            }
          }
        }

        // Copy to frame
        for (let y = 0; y < cell.height; y++) {
          for (let x = 0; x < cell.width; x++) {
            framePixelData[x + cell.xOffset + (y + cell.yOffset) * dirW] =
              dirPixelData[x + cell.xOffset + (y + cell.yOffset) * dirW];
          }
        }
        pbReadIdx++;
      }

      bufferCell.lastWidth = cell.width;
      bufferCell.lastHeight = cell.height;
      bufferCell.lastXOffset = cell.xOffset;
      bufferCell.lastYOffset = cell.yOffset;
    }

    // Extract the frame's actual pixels from the direction buffer
    const fLeft = fi.boxLeft - dirBoxLeft;
    const fTop = fi.boxTop - dirBoxTop;
    const pixels = new Uint8Array(fi.width * fi.height);

    for (let y = 0; y < fi.height; y++) {
      for (let x = 0; x < fi.width; x++) {
        pixels[y * fi.width + x] = framePixelData[(fTop + y) * dirW + (fLeft + x)];
      }
    }

    results.push({
      flip: 0,
      width: fi.width,
      height: fi.height,
      offsetX: fi.xOffset,
      offsetY: fi.yOffset,
      length: fi.codedBytes,
      direction: dirIdx,
      frameIndex: frameIdx,
      pixels,
    });
  }

  return results;
}

export function isDCCFile(data: Uint8Array): boolean {
  return data.length > 15 && data[0] === 0x74;
}
