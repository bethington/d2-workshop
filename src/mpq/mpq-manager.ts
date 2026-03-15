import * as path from "path";
import * as fs from "fs";
import { getStormLib, MPQ_OPEN_READ_ONLY } from "./stormlib-wasm";

/**
 * Manages all MPQ archives in the workspace.
 * Caches open handles and file listings for performance.
 */
export class MpqManager {
  private archives = new Map<
    string,
    {
      handle: number;
      fileList: string[] | null;
      directoryCache: Map<string, DirectoryEntry[]>;
    }
  >();

  constructor(private readonly workspaceRoot: string) {}

  /**
   * Get list of MPQ files in the workspace root.
   */
  getMpqFiles(): string[] {
    try {
      return fs
        .readdirSync(this.workspaceRoot)
        .filter((f) => f.toLowerCase().endsWith(".mpq"))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Ensure an MPQ archive is open and return its file list.
   */
  getFileList(mpqName: string): string[] {
    const entry = this.ensureOpen(mpqName);
    if (!entry.fileList) {
      const stormlib = getStormLib();
      entry.fileList = stormlib.listFiles(entry.handle);
    }
    return entry.fileList;
  }

  /**
   * List entries in a directory within an MPQ.
   */
  listDirectory(mpqName: string, dirPath: string): DirectoryEntry[] {
    const entry = this.ensureOpen(mpqName);

    // Check cache
    const cacheKey = dirPath.toLowerCase().replace(/\\/g, "/");
    if (entry.directoryCache.has(cacheKey)) {
      return entry.directoryCache.get(cacheKey)!;
    }

    const allFiles = this.getFileList(mpqName);
    const normalizedDir = dirPath.replace(/\\/g, "/").replace(/\/$/, "");
    const prefix = normalizedDir ? normalizedDir + "/" : "";

    const entries = new Map<string, boolean>();

    for (const file of allFiles) {
      const normalized = file.replace(/\\/g, "/");
      if (prefix && !normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
        continue;
      }

      const remainder = normalized.slice(prefix.length);
      if (!remainder) continue;

      const slashIdx = remainder.indexOf("/");
      if (slashIdx === -1) {
        entries.set(remainder, false);
      } else {
        const dirName = remainder.slice(0, slashIdx);
        entries.set(dirName, true);
      }
    }

    const result: DirectoryEntry[] = Array.from(entries.entries())
      .map(([name, isDirectory]) => ({
        name,
        isDirectory,
        fullPath: prefix + name,
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
        });
      });

    entry.directoryCache.set(cacheKey, result);
    return result;
  }

  /**
   * Read a file from an MPQ archive.
   */
  readFile(mpqName: string, fileName: string): Uint8Array {
    const entry = this.ensureOpen(mpqName);
    const stormlib = getStormLib();
    // StormLib expects backslash paths
    const normalizedName = fileName.replace(/\//g, "\\");
    const data = stormlib.readFile(entry.handle, normalizedName);
    if (!data) {
      throw new Error(`File not found in ${mpqName}: ${normalizedName}`);
    }
    return data;
  }

  /**
   * Check if a file exists in an MPQ archive.
   */
  hasFile(mpqName: string, fileName: string): boolean {
    const entry = this.ensureOpen(mpqName);
    const stormlib = getStormLib();
    return stormlib.hasFile(entry.handle, fileName.replace(/\//g, "\\"));
  }

  /**
   * Write a file to an MPQ archive.
   * Closes the read-only handle, reopens for writing, writes, then invalidates cache.
   */
  writeFile(mpqName: string, fileName: string, data: Uint8Array): void {
    const stormlib = getStormLib();

    // Close ALL open archive handles to release file locks
    this.closeAll();

    // Open in read-write mode (flags = 0 means no read-only flag)
    const fullPath = path.join(this.workspaceRoot, mpqName);
    const handle = stormlib.openArchive(fullPath, 0);

    try {
      const normalizedName = fileName.replace(/\//g, "\\");
      if (!stormlib.writeFile(handle, normalizedName, data)) {
        throw new Error(
          `Failed to write ${normalizedName} to ${mpqName}. ` +
          `The MPQ file may be locked by another program (e.g., MPQ Editor, Diablo II). ` +
          `Close any other tools using this file and try again.`
        );
      }
    } finally {
      stormlib.closeArchive(handle);
    }
  }

  /**
   * Close all open archives.
   */
  closeAll(): void {
    const stormlib = getStormLib();
    for (const [, entry] of this.archives) {
      try {
        stormlib.closeArchive(entry.handle);
      } catch {
        // Ignore close errors during cleanup
      }
    }
    this.archives.clear();
  }

  /**
   * Close and reopen an archive (e.g., after writing).
   */
  invalidate(mpqName: string): void {
    const key = mpqName.toLowerCase();
    const entry = this.archives.get(key);
    if (entry) {
      try {
        const stormlib = getStormLib();
        stormlib.closeArchive(entry.handle);
      } catch {
        // Ignore
      }
      this.archives.delete(key);
    }
  }

  private ensureOpen(mpqName: string): {
    handle: number;
    fileList: string[] | null;
    directoryCache: Map<string, DirectoryEntry[]>;
  } {
    const key = mpqName.toLowerCase();

    if (this.archives.has(key)) {
      return this.archives.get(key)!;
    }

    const fullPath = path.join(this.workspaceRoot, mpqName);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`MPQ file not found: ${fullPath}`);
    }

    const stormlib = getStormLib();
    const handle = stormlib.openArchive(fullPath, MPQ_OPEN_READ_ONLY);

    const entry = {
      handle,
      fileList: null as string[] | null,
      directoryCache: new Map<string, DirectoryEntry[]>(),
    };

    this.archives.set(key, entry);
    return entry;
  }
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  fullPath: string;
}
