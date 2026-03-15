/**
 * DC6 file format parser for Diablo II sprite images.
 *
 * DC6 Format:
 *   Header (24 bytes):
 *     - version (4 bytes): always 6
 *     - flags (4 bytes): unused, typically 1
 *     - encoding (4 bytes): always 0
 *     - termination (4 bytes): always 0xEEEEEEEE or 0xCDCDCDCD
 *     - directions (4 bytes): number of directions
 *     - framesPerDirection (4 bytes): frames per direction
 *
 *   Frame pointers (4 bytes × directions × framesPerDirection):
 *     - file offset to each frame header
 *
 *   Frame headers (variable):
 *     - flip (4 bytes): 0 = normal, 1 = flipped
 *     - width (4 bytes)
 *     - height (4 bytes)
 *     - offsetX (4 bytes): signed, left offset
 *     - offsetY (4 bytes): signed, bottom offset
 *     - allocSize (4 bytes): always 0
 *     - nextBlock (4 bytes): pointer to next frame (0 for last)
 *     - length (4 bytes): compressed data length
 *     - data (length bytes): RLE-compressed pixel data
 */

export interface DC6Header {
  version: number;
  flags: number;
  encoding: number;
  termination: number;
  directions: number;
  framesPerDirection: number;
}

export interface DC6Frame {
  flip: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  length: number;
  direction: number;
  frameIndex: number;
  pixels: Uint8Array; // Decoded palette indices (width × height)
}

export interface DC6File {
  header: DC6Header;
  frames: DC6Frame[];
}

/**
 * Parse a DC6 file from binary data.
 */
export function parseDC6(data: Uint8Array): DC6File {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Read header
  const header: DC6Header = {
    version: view.getInt32(offset, true),
    flags: view.getInt32(offset + 4, true),
    encoding: view.getInt32(offset + 8, true),
    termination: view.getUint32(offset + 12, true),
    directions: view.getInt32(offset + 16, true),
    framesPerDirection: view.getInt32(offset + 20, true),
  };
  offset = 24;

  const totalFrames = header.directions * header.framesPerDirection;

  // Read frame pointers
  const framePointers: number[] = [];
  for (let i = 0; i < totalFrames; i++) {
    framePointers.push(view.getUint32(offset, true));
    offset += 4;
  }

  // Read frames
  const frames: DC6Frame[] = [];
  for (let i = 0; i < totalFrames; i++) {
    const direction = Math.floor(i / header.framesPerDirection);
    const frameIndex = i % header.framesPerDirection;

    let fOffset = framePointers[i];

    const flip = view.getInt32(fOffset, true);
    fOffset += 4;
    const width = view.getInt32(fOffset, true);
    fOffset += 4;
    const height = view.getInt32(fOffset, true);
    fOffset += 4;
    const offsetX = view.getInt32(fOffset, true);
    fOffset += 4;
    const offsetY = view.getInt32(fOffset, true);
    fOffset += 4;
    fOffset += 4; // allocSize (skip)
    fOffset += 4; // nextBlock (skip)
    const length = view.getInt32(fOffset, true);
    fOffset += 4;

    // Decode RLE pixel data
    const compressedData = data.subarray(fOffset, fOffset + length);
    const pixels = decodeDC6Frame(compressedData, width, height);

    frames.push({
      flip,
      width,
      height,
      offsetX,
      offsetY,
      length,
      direction,
      frameIndex,
      pixels,
    });
  }

  return { header, frames };
}

/**
 * Decode DC6 RLE-compressed frame data to palette indices.
 *
 * DC6 RLE encoding:
 *   - Pixel data is stored bottom-to-top, left-to-right
 *   - Each scanline is encoded independently
 *   - Byte values:
 *     0x80: end of scanline
 *     bit 7 set (0x81-0xFF): transparent run of (byte & 0x7F) pixels
 *     bit 7 clear (0x01-0x7F): copy next N raw pixel bytes
 */
function decodeDC6Frame(
  compressed: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const pixels = new Uint8Array(width * height);
  let x = 0;
  let y = height - 1; // DC6 stores bottom-to-top
  let i = 0;

  while (i < compressed.length && y >= 0) {
    const b = compressed[i++];

    if (b === 0x80) {
      // End of scanline
      x = 0;
      y--;
    } else if (b & 0x80) {
      // Transparent run
      x += b & 0x7f;
    } else {
      // Raw pixel run
      const count = b;
      for (let j = 0; j < count && i < compressed.length; j++) {
        if (x < width && y >= 0) {
          pixels[y * width + x] = compressed[i];
        }
        x++;
        i++;
      }
    }
  }

  return pixels;
}
