/**
 * Lightweight PE (Portable Executable) header parser.
 * Extracts basic info, section table, and export table.
 */

export interface PEInfo {
  imageBase: number;
  entryPoint: number;
  sectionAlignment: number;
  fileAlignment: number;
  sizeOfImage: number;
  numberOfSections: number;
  sections: PESection[];
  exports: PEExport[];
  is64Bit: boolean;
}

export interface PESection {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  rawDataSize: number;
  rawDataPointer: number;
  characteristics: number;
}

export interface PEExport {
  name: string;
  ordinal: number;
  rva: number;
}

/**
 * Parse PE headers from binary data.
 */
export function parsePE(data: Uint8Array): PEInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Validate MZ header
  if (view.getUint16(0, true) !== 0x5a4d) {
    throw new Error("Not a valid PE file: missing MZ signature");
  }

  // PE header offset
  const peOffset = view.getUint32(0x3c, true);

  // Validate PE signature
  if (view.getUint32(peOffset, true) !== 0x00004550) {
    throw new Error("Not a valid PE file: missing PE signature");
  }

  // COFF header
  const coffOffset = peOffset + 4;
  const numberOfSections = view.getUint16(coffOffset + 2, true);
  const sizeOfOptionalHeader = view.getUint16(coffOffset + 16, true);

  // Optional header
  const optOffset = coffOffset + 20;
  const magic = view.getUint16(optOffset, true);
  const is64Bit = magic === 0x20b;

  let imageBase: number;
  let entryPoint: number;
  let sectionAlignment: number;
  let fileAlignment: number;
  let sizeOfImage: number;

  if (is64Bit) {
    entryPoint = view.getUint32(optOffset + 16, true);
    sectionAlignment = view.getUint32(optOffset + 32, true);
    fileAlignment = view.getUint32(optOffset + 36, true);
    sizeOfImage = view.getUint32(optOffset + 56, true);
    // 64-bit image base is at offset 24, 8 bytes
    imageBase = Number(view.getBigUint64(optOffset + 24, true));
  } else {
    entryPoint = view.getUint32(optOffset + 16, true);
    sectionAlignment = view.getUint32(optOffset + 32, true);
    fileAlignment = view.getUint32(optOffset + 36, true);
    sizeOfImage = view.getUint32(optOffset + 56, true);
    imageBase = view.getUint32(optOffset + 28, true);
  }

  // Section table
  const sectionTableOffset = optOffset + sizeOfOptionalHeader;
  const sections: PESection[] = [];

  for (let i = 0; i < numberOfSections; i++) {
    const secOffset = sectionTableOffset + i * 40;

    // Read section name (8 bytes, null-terminated)
    let name = "";
    for (let j = 0; j < 8; j++) {
      const ch = data[secOffset + j];
      if (ch === 0) break;
      name += String.fromCharCode(ch);
    }

    sections.push({
      name,
      virtualSize: view.getUint32(secOffset + 8, true),
      virtualAddress: view.getUint32(secOffset + 12, true),
      rawDataSize: view.getUint32(secOffset + 16, true),
      rawDataPointer: view.getUint32(secOffset + 20, true),
      characteristics: view.getUint32(secOffset + 36, true),
    });
  }

  // Export table
  const exports = parseExports(data, view, optOffset, is64Bit, sections);

  return {
    imageBase,
    entryPoint,
    sectionAlignment,
    fileAlignment,
    sizeOfImage,
    numberOfSections,
    sections,
    exports,
    is64Bit,
  };
}

/**
 * Convert RVA to file offset using section table.
 */
export function rvaToFileOffset(
  rva: number,
  sections: PESection[]
): number {
  for (const sec of sections) {
    if (rva >= sec.virtualAddress && rva < sec.virtualAddress + sec.virtualSize) {
      return sec.rawDataPointer + (rva - sec.virtualAddress);
    }
  }
  return -1;
}

/**
 * Read a value from a PE file at a given RVA.
 */
export function readAtRva(
  data: Uint8Array,
  rva: number,
  size: number,
  sections: PESection[]
): number {
  const offset = rvaToFileOffset(rva, sections);
  if (offset < 0 || offset + size > data.length) {
    return 0;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (size) {
    case 1:
      return view.getUint8(offset);
    case 2:
      return view.getUint16(offset, true);
    case 4:
      return view.getUint32(offset, true);
    default:
      return 0;
  }
}

function parseExports(
  data: Uint8Array,
  view: DataView,
  optOffset: number,
  is64Bit: boolean,
  sections: PESection[]
): PEExport[] {
  const exports: PEExport[] = [];

  // Export directory is the first data directory entry
  const ddOffset = is64Bit ? optOffset + 112 : optOffset + 96;
  const exportDirRva = view.getUint32(ddOffset, true);
  const exportDirSize = view.getUint32(ddOffset + 4, true);

  if (exportDirRva === 0 || exportDirSize === 0) {
    return exports;
  }

  const exportDirOffset = rvaToFileOffset(exportDirRva, sections);
  if (exportDirOffset < 0) {
    return exports;
  }

  const numberOfNames = view.getUint32(exportDirOffset + 24, true);
  const addressTableRva = view.getUint32(exportDirOffset + 28, true);
  const nameTableRva = view.getUint32(exportDirOffset + 32, true);
  const ordinalTableRva = view.getUint32(exportDirOffset + 36, true);
  const ordinalBase = view.getUint32(exportDirOffset + 16, true);

  const addressTableOffset = rvaToFileOffset(addressTableRva, sections);
  const nameTableOffset = rvaToFileOffset(nameTableRva, sections);
  const ordinalTableOffset = rvaToFileOffset(ordinalTableRva, sections);

  if (addressTableOffset < 0 || nameTableOffset < 0 || ordinalTableOffset < 0) {
    return exports;
  }

  for (let i = 0; i < numberOfNames; i++) {
    const nameRva = view.getUint32(nameTableOffset + i * 4, true);
    const ordinalIndex = view.getUint16(ordinalTableOffset + i * 2, true);
    const funcRva = view.getUint32(
      addressTableOffset + ordinalIndex * 4,
      true
    );

    const nameOffset = rvaToFileOffset(nameRva, sections);
    if (nameOffset < 0) {
      continue;
    }

    // Read null-terminated name
    let name = "";
    for (let j = nameOffset; j < data.length && data[j] !== 0; j++) {
      name += String.fromCharCode(data[j]);
    }

    exports.push({
      name,
      ordinal: ordinalBase + ordinalIndex,
      rva: funcRva,
    });
  }

  return exports;
}
