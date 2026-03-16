import * as vscode from "vscode";
import { MpqManager } from "../mpq/mpq-manager";

/**
 * Virtual filesystem provider for MPQ archives.
 * Registers the d2mpq:// URI scheme so MPQ contents appear as regular files.
 *
 * URI format: d2mpq://<mpq-filename>/data/path/to/file.txt
 */
export class MpqFileSystemProvider implements vscode.FileSystemProvider {
  private _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  // Cache for pending writes (before publish)
  private pendingWrites = new Map<string, Uint8Array>();

  constructor(private readonly mpqManager: MpqManager) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { mpqName, internalPath } = this.parseUri(uri);

    if (!internalPath) {
      // Root of the MPQ = directory
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: Date.now(),
        size: 0,
      };
    }

    // Check if it's a directory by seeing if anything is under this path
    try {
      const entries = this.mpqManager.listDirectory(mpqName, internalPath);
      if (entries.length > 0) {
        return {
          type: vscode.FileType.Directory,
          ctime: 0,
          mtime: Date.now(),
          size: 0,
        };
      }
    } catch {
      // Not a directory, try as file
    }

    // Check pending write cache for size
    const key = uri.toString();
    if (this.pendingWrites.has(key)) {
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: Date.now(),
        size: this.pendingWrites.get(key)!.length,
      };
    }

    // It's a file (or doesn't exist — we assume file)
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: Date.now(),
      size: 0,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { mpqName, internalPath } = this.parseUri(uri);

    try {
      const entries = this.mpqManager.listDirectory(mpqName, internalPath);
      return entries.map((entry) => [
        entry.name,
        entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
      ]);
    } catch {
      return [];
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const key = uri.toString();

    // Return pending write if exists
    if (this.pendingWrites.has(key)) {
      return this.pendingWrites.get(key)!;
    }

    const { mpqName, internalPath } = this.parseUri(uri);
    // MPQ files use backslash paths internally
    const mpqPath = internalPath.replace(/\//g, "\\");

    try {
      return this.mpqManager.readFile(mpqName, mpqPath);
    } catch (err) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    // Queue write — don't write to MPQ immediately
    this.pendingWrites.set(uri.toString(), content);
    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Changed, uri },
    ]);
  }

  async delete(_uri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(
      "Cannot delete files from MPQ archives"
    );
  }

  async rename(_oldUri: vscode.Uri, _newUri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(
      "Cannot rename files in MPQ archives"
    );
  }

  async createDirectory(_uri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(
      "Cannot create directories in MPQ archives"
    );
  }

  /**
   * Get all pending writes for publishing.
   */
  getPendingWrites(): Map<string, Uint8Array> {
    return new Map(this.pendingWrites);
  }

  /**
   * Clear pending writes after successful publish.
   */
  clearPendingWrites(): void {
    this.pendingWrites.clear();
  }

  private parseUri(uri: vscode.Uri): {
    mpqName: string;
    internalPath: string;
  } {
    const mpqName = decodeURIComponent(uri.authority);
    const internalPath = uri.path.startsWith("/")
      ? uri.path.slice(1)
      : uri.path;
    return { mpqName, internalPath };
  }
}
