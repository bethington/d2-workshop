import * as fs from "fs";
import { rvaToFileOffset, PESection } from "./pe-reader";

export interface PatchEntry {
  rva: string;
  orig: string;
  patch: string;
  desc: string;
}

export interface PatchGroup {
  name: string;
  description: string;
  dlls: Record<string, PatchEntry[]>;
}

export interface PatchResult {
  success: boolean;
  message: string;
  entry: PatchEntry;
  dll: string;
}

/**
 * Applies and reverts binary patches with verification and undo tracking.
 */
export class BinaryPatcher {
  /**
   * Apply a single patch entry to a file.
   * Verifies original bytes before patching.
   */
  applyPatch(
    filePath: string,
    entry: PatchEntry,
    sections: PESection[]
  ): PatchResult {
    const rva = parseInt(entry.rva, 16);
    const data = Buffer.from(fs.readFileSync(filePath));
    const offset = rvaToFileOffset(rva, sections);

    if (offset < 0) {
      return {
        success: false,
        message: `RVA 0x${entry.rva} not found in sections`,
        entry,
        dll: filePath,
      };
    }

    const origBytes = Buffer.from(entry.orig, "hex");
    const patchBytes = Buffer.from(entry.patch, "hex");
    const currentBytes = data.subarray(offset, offset + origBytes.length);

    // Check if already patched
    if (currentBytes.equals(patchBytes)) {
      return {
        success: true,
        message: "Already patched",
        entry,
        dll: filePath,
      };
    }

    // Verify original bytes
    if (!currentBytes.equals(origBytes)) {
      return {
        success: false,
        message:
          `Verification failed: expected ${entry.orig}, ` +
          `got ${currentBytes.toString("hex")}`,
        entry,
        dll: filePath,
      };
    }

    // Apply patch
    patchBytes.copy(data, offset);
    fs.writeFileSync(filePath, data);

    return {
      success: true,
      message: `Applied: ${entry.desc}`,
      entry,
      dll: filePath,
    };
  }

  /**
   * Revert a patch (write original bytes back).
   */
  revertPatch(
    filePath: string,
    entry: PatchEntry,
    sections: PESection[]
  ): PatchResult {
    const rva = parseInt(entry.rva, 16);
    const data = Buffer.from(fs.readFileSync(filePath));
    const offset = rvaToFileOffset(rva, sections);

    if (offset < 0) {
      return {
        success: false,
        message: `RVA 0x${entry.rva} not found in sections`,
        entry,
        dll: filePath,
      };
    }

    const origBytes = Buffer.from(entry.orig, "hex");
    const patchBytes = Buffer.from(entry.patch, "hex");
    const currentBytes = data.subarray(offset, offset + patchBytes.length);

    // Check if already reverted
    if (currentBytes.equals(origBytes)) {
      return {
        success: true,
        message: "Already reverted",
        entry,
        dll: filePath,
      };
    }

    // Verify patched bytes
    if (!currentBytes.equals(patchBytes)) {
      return {
        success: false,
        message:
          `Verification failed: expected ${entry.patch}, ` +
          `got ${currentBytes.toString("hex")}`,
        entry,
        dll: filePath,
      };
    }

    // Revert to original
    origBytes.copy(data, offset);
    fs.writeFileSync(filePath, data);

    return {
      success: true,
      message: `Reverted: ${entry.desc}`,
      entry,
      dll: filePath,
    };
  }

  /**
   * Apply or revert an entire patch group across multiple DLLs.
   */
  togglePatchGroup(
    workspaceRoot: string,
    group: PatchGroup,
    enable: boolean,
    sectionsByDll: Map<string, PESection[]>
  ): PatchResult[] {
    const results: PatchResult[] = [];

    for (const [dllName, entries] of Object.entries(group.dlls)) {
      const sections = sectionsByDll.get(dllName);
      if (!sections) {
        results.push({
          success: false,
          message: `No section info for ${dllName}`,
          entry: entries[0],
          dll: dllName,
        });
        continue;
      }

      const filePath = require("path").join(workspaceRoot, dllName);
      if (!fs.existsSync(filePath)) {
        results.push({
          success: false,
          message: `File not found: ${dllName}`,
          entry: entries[0],
          dll: dllName,
        });
        continue;
      }

      for (const entry of entries) {
        const result = enable
          ? this.applyPatch(filePath, entry, sections)
          : this.revertPatch(filePath, entry, sections);
        results.push(result);
      }
    }

    return results;
  }
}
