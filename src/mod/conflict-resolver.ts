import * as fs from "fs";

export interface ConflictItem {
  path: string;
  type: "mpq-file" | "binary-patch";
  currentValue: string;
  incomingValue: string;
  expectedOriginal: string;
  description: string;
}

export type ConflictResolution = "accept-theirs" | "keep-mine" | "skip";

/**
 * Detects and resolves conflicts when importing mod packages.
 */
export class ConflictResolver {
  /**
   * Check a binary patch for conflicts.
   * Returns null if no conflict, or a ConflictItem if the current bytes
   * don't match the expected original.
   */
  checkBinaryConflict(
    filePath: string,
    rva: number,
    origHex: string,
    patchHex: string,
    description: string,
    peOffsetResolver: (data: Buffer, rva: number) => number
  ): ConflictItem | null {
    const data = Buffer.from(fs.readFileSync(filePath));
    const offset = peOffsetResolver(data, rva);

    if (offset < 0) {
      return {
        path: `${filePath}@0x${rva.toString(16)}`,
        type: "binary-patch",
        currentValue: "<invalid RVA>",
        incomingValue: patchHex,
        expectedOriginal: origHex,
        description,
      };
    }

    const size = origHex.length / 2;
    const currentBytes = data.subarray(offset, offset + size).toString("hex");

    if (currentBytes === origHex) {
      // No conflict — original bytes are intact
      return null;
    }

    if (currentBytes === patchHex) {
      // Already patched — no conflict but skip
      return null;
    }

    // Conflict — bytes have been modified by something else
    return {
      path: `${filePath}@0x${rva.toString(16)}`,
      type: "binary-patch",
      currentValue: currentBytes,
      incomingValue: patchHex,
      expectedOriginal: origHex,
      description,
    };
  }

  /**
   * Apply a resolution to a binary conflict.
   */
  applyBinaryResolution(
    filePath: string,
    rva: number,
    resolution: ConflictResolution,
    patchHex: string,
    peOffsetResolver: (data: Buffer, rva: number) => number
  ): boolean {
    if (resolution === "skip" || resolution === "keep-mine") {
      return false;
    }

    const data = Buffer.from(fs.readFileSync(filePath));
    const offset = peOffsetResolver(data, rva);

    if (offset < 0) {
      return false;
    }

    const patchBytes = Buffer.from(patchHex, "hex");
    patchBytes.copy(data, offset);
    fs.writeFileSync(filePath, data);

    return true;
  }
}
