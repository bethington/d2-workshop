import { DC6File, DC6Frame, DC6Header } from "./dc6-parser";

/**
 * Encode DC6 frames back into binary format.
 * Used for round-trip editing (GIMP export → re-import → DC6).
 */
export function encodeDC6(header: DC6Header, frames: DC6Frame[]): Uint8Array {
  const totalFrames = frames.length;

  // Encode each frame's pixel data
  const encodedFrames: Uint8Array[] = frames.map((frame) =>
    encodeDC6Frame(frame.pixels, frame.width, frame.height)
  );

  // Calculate total size
  const headerSize = 24;
  const pointersSize = totalFrames * 4;
  const frameHeaderSize = 32; // 8 fields × 4 bytes
  let totalSize = headerSize + pointersSize;

  for (const encoded of encodedFrames) {
    totalSize += frameHeaderSize + encoded.length;
  }

  // Build output buffer
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  let offset = 0;

  // Write header
  view.setInt32(offset, header.version, true);
  offset += 4;
  view.setInt32(offset, header.flags, true);
  offset += 4;
  view.setInt32(offset, header.encoding, true);
  offset += 4;
  view.setUint32(offset, header.termination, true);
  offset += 4;
  view.setInt32(offset, header.directions, true);
  offset += 4;
  view.setInt32(offset, header.framesPerDirection, true);
  offset += 4;

  // Calculate frame pointers
  let frameDataStart = headerSize + pointersSize;
  const pointerOffset = offset;

  for (let i = 0; i < totalFrames; i++) {
    view.setUint32(offset, frameDataStart, true);
    offset += 4;
    frameDataStart += frameHeaderSize + encodedFrames[i].length;
  }

  // Write frame headers and data
  for (let i = 0; i < totalFrames; i++) {
    const frame = frames[i];
    const encoded = encodedFrames[i];

    view.setInt32(offset, frame.flip, true);
    offset += 4;
    view.setInt32(offset, frame.width, true);
    offset += 4;
    view.setInt32(offset, frame.height, true);
    offset += 4;
    view.setInt32(offset, frame.offsetX, true);
    offset += 4;
    view.setInt32(offset, frame.offsetY, true);
    offset += 4;
    view.setInt32(offset, 0, true); // allocSize
    offset += 4;
    // nextBlock: pointer to next frame or 0 for last
    const nextFramePointer =
      i < totalFrames - 1
        ? view.getUint32(pointerOffset + (i + 1) * 4, true)
        : 0;
    view.setUint32(offset, nextFramePointer, true);
    offset += 4;
    view.setInt32(offset, encoded.length, true);
    offset += 4;

    // Write compressed data
    output.set(encoded, offset);
    offset += encoded.length;
  }

  return output;
}

/**
 * RLE-encode a single frame's pixel data.
 * Encodes bottom-to-top, left-to-right with DC6 RLE scheme.
 */
function encodeDC6Frame(
  pixels: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const chunks: Uint8Array[] = [];

  for (let y = height - 1; y >= 0; y--) {
    const row = pixels.subarray(y * width, (y + 1) * width);
    const rowEncoded = encodeRow(row);
    chunks.push(rowEncoded);
    chunks.push(new Uint8Array([0x80])); // End of scanline
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Encode a single row using DC6 RLE.
 */
function encodeRow(row: Uint8Array): Uint8Array {
  const chunks: number[] = [];
  let i = 0;

  while (i < row.length) {
    // Check for transparent run (index 0 = transparent in D2)
    if (row[i] === 0) {
      let count = 0;
      while (i < row.length && row[i] === 0 && count < 127) {
        count++;
        i++;
      }
      chunks.push(0x80 | count);
      continue;
    }

    // Raw pixel run
    const start = i;
    let count = 0;
    while (i < row.length && row[i] !== 0 && count < 127) {
      count++;
      i++;
    }
    chunks.push(count);
    for (let j = start; j < start + count; j++) {
      chunks.push(row[j]);
    }
  }

  return new Uint8Array(chunks);
}
