import { getStormLib, StormLibModule } from "./stormlib-wasm";

/**
 * High-level API for MPQ archive operations.
 * Wraps StormLib WASM with caching and error handling.
 */
export class MpqArchive {
  private handle: number | null = null;
  private fileListCache: string[] | null = null;

  constructor(private readonly path: string) {}

  /**
   * Open the archive. Must be called before any read/write operations.
   */
  async open(): Promise<void> {
    if (this.handle !== null) {
      return;
    }

    const stormlib = getStormLib();
    // MPQ_OPEN_READ_ONLY = 0x00000100
    // MPQ_OPEN_EXISTING = 0x00000000
    this.handle = stormlib.openArchive(this.path, 0x00000100);
  }

  /**
   * Close the archive and release resources.
   */
  close(): void {
    if (this.handle === null) {
      return;
    }

    const stormlib = getStormLib();
    stormlib.closeArchive(this.handle);
    this.handle = null;
    this.fileListCache = null;
  }

  /**
   * List all files in the archive.
   */
  listFiles(): string[] {
    if (this.fileListCache) {
      return this.fileListCache;
    }

    this.ensureOpen();
    const stormlib = getStormLib();
    this.fileListCache = stormlib.listFiles(this.handle!);
    return this.fileListCache;
  }

  /**
   * List files in a specific directory within the archive.
   */
  listDirectory(dirPath: string): Array<{ name: string; isDirectory: boolean }> {
    const allFiles = this.listFiles();
    const normalizedDir = dirPath.replace(/\\/g, "/").replace(/\/$/, "");
    const prefix = normalizedDir ? normalizedDir + "/" : "";

    const entries = new Map<string, boolean>();

    for (const file of allFiles) {
      const normalized = file.replace(/\\/g, "/");
      if (!normalized.startsWith(prefix)) {
        continue;
      }

      const remainder = normalized.slice(prefix.length);
      const slashIdx = remainder.indexOf("/");

      if (slashIdx === -1) {
        // File in this directory
        entries.set(remainder, false);
      } else {
        // Subdirectory
        const dirName = remainder.slice(0, slashIdx);
        entries.set(dirName, true);
      }
    }

    return Array.from(entries.entries())
      .map(([name, isDirectory]) => ({ name, isDirectory }))
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
  }

  /**
   * Read a file from the archive.
   */
  readFile(fileName: string): Uint8Array {
    this.ensureOpen();
    const stormlib = getStormLib();
    const data = stormlib.readFile(this.handle!, fileName);
    if (!data) {
      throw new Error(`File not found in MPQ: ${fileName}`);
    }
    return data;
  }

  /**
   * Write a file to the archive.
   * Note: This reopens the archive in write mode.
   */
  writeFile(fileName: string, data: Uint8Array): void {
    // Close and reopen in write mode
    if (this.handle !== null) {
      const stormlib = getStormLib();
      stormlib.closeArchive(this.handle);
    }

    const stormlib = getStormLib();
    // Reopen in read-write mode (flags = 0)
    this.handle = stormlib.openArchive(this.path, 0);

    if (!stormlib.writeFile(this.handle, fileName, data)) {
      throw new Error(`Failed to write file to MPQ: ${fileName}`);
    }

    this.fileListCache = null; // Invalidate cache

    // Reopen in read-only mode
    stormlib.closeArchive(this.handle);
    this.handle = stormlib.openArchive(this.path, 0x00000100);
  }

  /**
   * Check if a file exists in the archive.
   */
  hasFile(fileName: string): boolean {
    this.ensureOpen();
    const stormlib = getStormLib();
    return stormlib.hasFile(this.handle!, fileName);
  }

  private ensureOpen(): void {
    if (this.handle === null) {
      throw new Error("Archive not open. Call open() first.");
    }
  }
}
