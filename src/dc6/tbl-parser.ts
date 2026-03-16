/**
 * TBL (Text/String Table) file format parser for Diablo II.
 *
 * TBL files contain localized game strings used for item names, skill
 * descriptions, UI text, NPC dialogue, etc. They use a hash table
 * structure for fast key-based lookup.
 *
 * Files: string.tbl, expansionstring.tbl, patchstring.tbl
 *
 * Based on the OpenDiablo2 reference implementation.
 */

export interface TBLEntry {
  key: string;
  value: string;
}

export interface TBLFile {
  entries: TBLEntry[];
}

interface HashEntry {
  isActive: boolean;
  index: number;
  hashValue: number;
  indexStringOffset: number;
  nameStringOffset: number;
  nameLength: number;
}

/**
 * Parse a TBL string table file.
 * Returns an array of key-value string pairs.
 */
export function parseTBL(data: Uint8Array): TBLFile {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Skip CRC (2 bytes)
  offset += 2;

  // Number of element indices
  const numberOfElements = view.getUint16(offset, true); offset += 2;

  // Hash table size
  const hashTableSize = view.getUint32(offset, true); offset += 4;

  // Version (1 byte)
  offset += 1;

  // String data offset (4 bytes)
  offset += 4;

  // Max retry count (4 bytes)
  offset += 4;

  // File size (4 bytes)
  offset += 4;

  // Element index array (numberOfElements × 2 bytes)
  offset += numberOfElements * 2;

  // Read hash entries (each is 17 bytes: 1+2+4+4+4+2)
  const hashEntries: HashEntry[] = [];
  for (let i = 0; i < hashTableSize; i++) {
    if (offset + 17 > data.length) break;

    const isActive = data[offset] > 0; offset += 1;
    const index = view.getUint16(offset, true); offset += 2;
    const hashValue = view.getUint32(offset, true); offset += 4;
    const indexStringOffset = view.getUint32(offset, true); offset += 4;
    const nameStringOffset = view.getUint32(offset, true); offset += 4;
    const nameLength = view.getUint16(offset, true); offset += 2;

    hashEntries.push({
      isActive, index, hashValue,
      indexStringOffset, nameStringOffset, nameLength,
    });
  }

  // Read strings for active entries
  const entries: TBLEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < hashEntries.length; i++) {
    const entry = hashEntries[i];
    if (!entry.isActive) continue;
    if (entry.nameStringOffset >= data.length || entry.indexStringOffset >= data.length) continue;

    // Read value string
    let value = "";
    if (entry.nameLength > 1) {
      const end = Math.min(entry.nameStringOffset + entry.nameLength - 1, data.length);
      for (let j = entry.nameStringOffset; j < end; j++) {
        value += String.fromCharCode(data[j]);
      }
    }

    // Read key string (null-terminated)
    let key = "";
    for (let j = entry.indexStringOffset; j < data.length; j++) {
      if (data[j] === 0) break;
      key += String.fromCharCode(data[j]);
    }

    // Keys that are "x" or "X" are numeric index references
    if (key === "x" || key === "X") {
      key = "#" + i;
    }

    // Skip duplicates
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({ key, value });
    }
  }

  // Sort by key for consistent display
  entries.sort((a, b) => a.key.localeCompare(b.key));

  return { entries };
}

/**
 * Encode a TBL file from key-value pairs.
 * Produces a binary format compatible with D2's string table loader.
 */
export function encodeTBL(entries: TBLEntry[]): Uint8Array {
  // Calculate sizes
  const hashTableSize = entries.length;

  // Build data section: key strings + value strings
  const dataChunks: Uint8Array[] = [];
  const entryMeta: Array<{
    keyOffset: number;
    valueOffset: number;
    valueLength: number;
  }> = [];

  // Header: CRC(2) + numElements(2) + hashTableSize(4) + version(1) + stringOffset(4) + maxRetry(4) + fileSize(4) = 21
  // Element indices: 0 (we set numberOfElements=0)
  // Hash entries: hashTableSize × 17
  const headerSize = 21;
  const hashSectionSize = hashTableSize * 17;
  let dataOffset = headerSize + hashSectionSize;

  for (const entry of entries) {
    const keyBytes = entry.key.startsWith("#") ? "x" : entry.key;
    const keyOffset = dataOffset;
    dataOffset += keyBytes.length + 1; // +1 for null terminator

    const valueOffset = dataOffset;
    const valueLength = entry.value.length + 1; // +1 for null terminator
    dataOffset += valueLength;

    entryMeta.push({ keyOffset, valueOffset, valueLength });
  }

  const totalSize = dataOffset;
  const result = new Uint8Array(totalSize);
  const resultView = new DataView(result.buffer);
  let writeOffset = 0;

  // CRC (2 bytes, zeros)
  writeOffset += 2;

  // numberOfElements = 0
  resultView.setUint16(writeOffset, 0, true); writeOffset += 2;

  // hashTableSize
  resultView.setUint32(writeOffset, hashTableSize, true); writeOffset += 4;

  // version = 0
  result[writeOffset++] = 0;

  // stringOffset (unused by our decoder)
  resultView.setUint32(writeOffset, 0, true); writeOffset += 4;

  // maxRetryCount
  resultView.setUint32(writeOffset, 0, true); writeOffset += 4;

  // fileSize
  resultView.setUint32(writeOffset, totalSize, true); writeOffset += 4;

  // No element indices (numberOfElements = 0)

  // Hash entries
  for (let i = 0; i < entries.length; i++) {
    const meta = entryMeta[i];

    // isActive = 1
    result[writeOffset++] = 1;

    // index = 0
    resultView.setUint16(writeOffset, 0, true); writeOffset += 2;

    // hashValue = 0
    resultView.setUint32(writeOffset, 0, true); writeOffset += 4;

    // indexStringOffset (key)
    resultView.setUint32(writeOffset, meta.keyOffset, true); writeOffset += 4;

    // nameStringOffset (value)
    resultView.setUint32(writeOffset, meta.valueOffset, true); writeOffset += 4;

    // nameLength
    resultView.setUint16(writeOffset, meta.valueLength, true); writeOffset += 2;
  }

  // Data section: key + null + value + null
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const keyStr = entry.key.startsWith("#") ? "x" : entry.key;

    // Write key
    for (let j = 0; j < keyStr.length; j++) {
      result[writeOffset++] = keyStr.charCodeAt(j);
    }
    result[writeOffset++] = 0; // null terminator

    // Write value
    for (let j = 0; j < entry.value.length; j++) {
      result[writeOffset++] = entry.value.charCodeAt(j);
    }
    result[writeOffset++] = 0; // null terminator
  }

  return result;
}

/**
 * Convert TBL entries to tab-delimited text for the table editor.
 * Two columns: Key and Value.
 */
export function tblToTabDelimited(entries: TBLEntry[]): string {
  const lines = ["Key\tValue"];
  for (const entry of entries) {
    // Escape tabs and newlines in values for TSV format
    const safeValue = entry.value.replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "");
    lines.push(`${entry.key}\t${safeValue}`);
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Convert tab-delimited text back to TBL entries.
 */
export function tabDelimitedToTbl(text: string): TBLEntry[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  // Skip header line
  const entries: TBLEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    const key = parts[0] || "";
    const value = (parts[1] || "").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
    if (key) {
      entries.push({ key, value });
    }
  }
  return entries;
}

/**
 * Check if data looks like a TBL file.
 */
export function isTBLFile(data: Uint8Array): boolean {
  if (data.length < 21) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Check: hashTableSize should be reasonable
  const hashTableSize = view.getUint32(4, true);
  // File size field should roughly match actual size
  const declaredSize = view.getUint32(17, true);
  return hashTableSize > 0 && hashTableSize < 100000 &&
         (declaredSize === 0 || Math.abs(declaredSize - data.length) < 1000);
}
