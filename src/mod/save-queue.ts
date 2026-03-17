import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { MpqManager } from "../mpq/mpq-manager";

export interface CellDiff {
  /** Row identifier (first column value, or row index if empty) */
  rowName: string;
  /** Row index in the table */
  rowIndex: number;
  /** Column name */
  column: string;
  /** Original value */
  oldValue: string;
  /** New value */
  newValue: string;
}

export interface MpqFileChange {
  type: "mpq-file";
  uri: string;
  content: string;
  /** Cell-level diffs computed at queue time */
  diffs?: CellDiff[];
  /** If true, content is base64-encoded binary (e.g., TBL files) */
  isBinary?: boolean;
}

export interface BinaryGlobalChange {
  type: "binary-global";
  filePath: string;
  rva: number;
  value: number;
  size: number;
}

export type QueuedChange = MpqFileChange | BinaryGlobalChange;

/**
 * Compute cell-level diffs between two tab-separated text contents.
 * Returns an array of CellDiff objects describing individual cell changes.
 */
export function computeTableDiffs(original: string, modified: string): CellDiff[] {
  const diffs: CellDiff[] = [];

  const origLines = original.split(/\r?\n/);
  const modLines = modified.split(/\r?\n/);

  // Remove trailing empty lines
  while (origLines.length > 0 && origLines[origLines.length - 1].trim() === "") origLines.pop();
  while (modLines.length > 0 && modLines[modLines.length - 1].trim() === "") modLines.pop();

  if (origLines.length === 0 || modLines.length === 0) return diffs;

  // First line is headers — use header count as the authoritative column count
  const headers = origLines[0].split("\t");
  const colCount = headers.length;

  // Compare only rows that exist in both, up to header column count
  const maxRows = Math.max(origLines.length, modLines.length);
  for (let r = 1; r < maxRows; r++) {
    const origCols = r < origLines.length ? origLines[r].split("\t") : [];
    const modCols = r < modLines.length ? modLines[r].split("\t") : [];
    const rowName = (modCols[0] || origCols[0] || "").trim() || `Row ${r}`;

    for (let c = 0; c < colCount; c++) {
      const oldVal = c < origCols.length ? origCols[c] : "";
      const newVal = c < modCols.length ? modCols[c] : "";
      // Compare raw values without trimming to detect real changes only
      if (oldVal === newVal) continue;
      // Also skip if both are effectively empty
      if (oldVal.trim() === "" && newVal.trim() === "") continue;

      diffs.push({
        rowName,
        rowIndex: r,
        column: headers[c] || `Col ${c}`,
        oldValue: oldVal,
        newValue: newVal,
      });
    }
  }

  return diffs;
}

/**
 * Manages pending changes across MPQ files and binary globals.
 * Changes are staged here until the user explicitly publishes them.
 */
export class SaveQueue {
  private changes: QueuedChange[] = [];
  private queueDir: string;
  private queueFile: string;
  private backupDir: string;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private workspaceRoot: string,
    private mpqManager?: MpqManager
  ) {
    this.queueDir = path.join(workspaceRoot, ".d2workshop", "queue");
    this.queueFile = path.join(this.queueDir, "pending-changes.json");
    this.backupDir = path.join(workspaceRoot, ".d2workshop", "backups");
    this.loadQueue();
  }

  /**
   * Switch to a different mod's queue.
   * Saves current queue, switches paths, loads new queue.
   */
  switchRoot(newRoot: string, newMpqManager?: MpqManager): void {
    this.saveQueue();
    this.workspaceRoot = newRoot;
    if (newMpqManager) this.mpqManager = newMpqManager;
    this.queueDir = path.join(newRoot, ".d2workshop", "queue");
    this.queueFile = path.join(this.queueDir, "pending-changes.json");
    this.backupDir = path.join(newRoot, ".d2workshop", "backups");
    this.loadQueue();
    this._onDidChange.fire();
  }

  queueChange(change: QueuedChange): void {
    // Remove existing change for same target
    this.changes = this.changes.filter((c) => {
      if (c.type === "mpq-file" && change.type === "mpq-file") {
        return c.uri !== change.uri;
      }
      if (c.type === "binary-global" && change.type === "binary-global") {
        return !(c.filePath === change.filePath && c.rva === change.rva);
      }
      return true;
    });

    this.changes.push(change);
    this.saveQueue();
    this._onDidChange.fire();
  }

  getChanges(): readonly QueuedChange[] {
    return this.changes;
  }

  getChangeCount(): number {
    return this.changes.length;
  }

  removeChange(index: number): void {
    this.changes.splice(index, 1);
    this.saveQueue();
    this._onDidChange.fire();
  }

  clearQueue(): void {
    this.changes = [];
    this.saveQueue();
    this._onDidChange.fire();
  }

  async publish(): Promise<void> {
    if (this.changes.length === 0) {
      vscode.window.showInformationMessage("No pending changes to publish.");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Publish ${this.changes.length} pending change(s)? This will modify game files.`,
      { modal: true },
      "Publish"
    );

    if (confirm !== "Publish") {
      return;
    }

    try {
      // Create backups first (if enabled)
      const config = vscode.workspace.getConfiguration("d2workshop");
      if (config.get<boolean>("autoBackup", true)) {
        await this.createBackups();
      }

      const mpqChanges = this.changes.filter(
        (c): c is MpqFileChange => c.type === "mpq-file"
      );
      const binaryChanges = this.changes.filter(
        (c): c is BinaryGlobalChange => c.type === "binary-global"
      );

      let mpqPublished = 0;
      let binaryPublished = 0;
      const errors: string[] = [];

      // Apply MPQ changes — continue on individual failures
      for (const change of mpqChanges) {
        try {
          await this.publishSingleMpqChange(change);
          mpqPublished++;
        } catch (err) {
          const uri = vscode.Uri.parse(change.uri);
          const fileName = uri.path.split("/").pop() || change.uri;
          errors.push(`${fileName}: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Invalidate MPQ cache after writes
      if (mpqPublished > 0 && this.mpqManager) {
        const mpqNames = new Set(mpqChanges.map(c => {
          const uri = vscode.Uri.parse(c.uri);
          return decodeURIComponent(uri.authority);
        }));
        for (const name of mpqNames) {
          this.mpqManager.invalidate(name);
        }
      }

      // Apply binary changes
      if (binaryChanges.length > 0) {
        try {
          await this.publishBinaryChanges(binaryChanges);
          binaryPublished = binaryChanges.length;
        } catch (err) {
          errors.push(`Binary patches: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Only clear successfully published changes
      const totalPublished = mpqPublished + binaryPublished;
      if (errors.length === 0) {
        this.clearQueue();
        vscode.window.showInformationMessage(
          `Successfully published ${totalPublished} change(s).`
        );
      } else if (totalPublished > 0) {
        // Partial success — remove published, keep failed
        this.changes = this.changes.filter(c => {
          if (c.type === "mpq-file") return errors.some(e => e.includes(c.uri));
          if (c.type === "binary-global") return binaryPublished === 0;
          return true;
        });
        this.saveQueue();
        this._onDidChange.fire();
        vscode.window.showWarningMessage(
          `Published ${totalPublished} change(s) but ${errors.length} failed:\n${errors.join("\n")}`
        );
      } else {
        vscode.window.showErrorMessage(
          `Publish failed:\n${errors.join("\n")}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Publish failed: ${msg}`);
    }
  }

  private async createBackups(): Promise<void> {
    fs.mkdirSync(this.backupDir, { recursive: true });

    const targets = new Set<string>();

    for (const change of this.changes) {
      if (change.type === "mpq-file") {
        // Extract MPQ name from URI
        const uri = vscode.Uri.parse(change.uri);
        const mpqName = decodeURIComponent(uri.authority);
        targets.add(path.join(this.workspaceRoot, mpqName));
      } else if (change.type === "binary-global") {
        targets.add(change.filePath);
      }
    }

    for (const target of targets) {
      const backupPath = path.join(
        this.backupDir,
        path.basename(target) + ".bak"
      );
      if (!fs.existsSync(backupPath) && fs.existsSync(target)) {
        fs.copyFileSync(target, backupPath);
      }
    }
  }

  private async publishSingleMpqChange(change: MpqFileChange): Promise<void> {
    if (!this.mpqManager) {
      throw new Error("MPQ manager not available — cannot write to MPQ archives.");
    }

    const uri = vscode.Uri.parse(change.uri);
    const mpqName = decodeURIComponent(uri.authority);
    const internalPath = uri.path.replace(/^\//, "");

    // Encode content: binary (base64) for TBL files, latin1 for text files
    const data = change.isBinary
      ? Buffer.from(change.content, "base64")
      : Buffer.from(change.content, "latin1");

    this.mpqManager.writeFile(mpqName, internalPath, new Uint8Array(data));
    console.log(`[D2 Workshop] Published ${internalPath} to ${mpqName}`);

    // Auto-delete corresponding .bin file when publishing a .txt change
    // This forces the game engine to reparse the .txt on next launch
    const autoDeleteBin = vscode.workspace
      .getConfiguration("d2workshop")
      .get<boolean>("autoDeleteBin", true);
    if (autoDeleteBin && internalPath.toLowerCase().endsWith(".txt")) {
      const binPath = internalPath.replace(/\.txt$/i, ".bin");
      try {
        this.mpqManager.deleteFile(mpqName, binPath);
        console.log(`[D2 Workshop] Deleted ${binPath} from ${mpqName} (forces engine reparse)`);
      } catch {
        // .bin may not exist — that's fine
      }
    }
  }

  private async publishBinaryChanges(
    changes: BinaryGlobalChange[]
  ): Promise<void> {
    // Group changes by file
    const byFile = new Map<string, BinaryGlobalChange[]>();
    for (const change of changes) {
      const existing = byFile.get(change.filePath) || [];
      existing.push(change);
      byFile.set(change.filePath, existing);
    }

    for (const [filePath, fileChanges] of byFile) {
      const data = Buffer.from(fs.readFileSync(filePath));

      for (const change of fileChanges) {
        const offset = this.rvaToFileOffset(data, change.rva);
        if (offset < 0) {
          throw new Error(
            `RVA 0x${change.rva.toString(16)} not found in ${path.basename(filePath)}`
          );
        }

        if (offset + change.size > data.length) {
          throw new Error(
            `Write at offset ${offset} + ${change.size} bytes exceeds file size ${data.length} in ${path.basename(filePath)}`
          );
        }

        switch (change.size) {
          case 1:
            data.writeUInt8(change.value, offset);
            break;
          case 2:
            data.writeUInt16LE(change.value, offset);
            break;
          case 4:
            data.writeUInt32LE(change.value, offset);
            break;
          default:
            throw new Error(`Unsupported size: ${change.size}`);
        }
      }

      fs.writeFileSync(filePath, data);
    }
  }

  private rvaToFileOffset(peData: Buffer, rva: number): number {
    if (peData.length < 0x40) return -1;
    const peOffset = peData.readUInt32LE(0x3c);
    if (peOffset + 24 > peData.length) return -1;
    const numSections = peData.readUInt16LE(peOffset + 6);
    const optHeaderSize = peData.readUInt16LE(peOffset + 20);
    const sectionTableOffset = peOffset + 24 + optHeaderSize;
    if (sectionTableOffset + numSections * 40 > peData.length) return -1;

    for (let i = 0; i < numSections; i++) {
      const secOffset = sectionTableOffset + i * 40;
      const virtualSize = peData.readUInt32LE(secOffset + 8);
      const virtualAddr = peData.readUInt32LE(secOffset + 12);
      const rawDataPtr = peData.readUInt32LE(secOffset + 20);

      if (rva >= virtualAddr && rva < virtualAddr + virtualSize) {
        return rawDataPtr + (rva - virtualAddr);
      }
    }

    return -1;
  }

  private loadQueue(): void {
    try {
      if (fs.existsSync(this.queueFile)) {
        const raw = fs.readFileSync(this.queueFile, "utf-8");
        this.changes = JSON.parse(raw);
        if (!Array.isArray(this.changes)) {
          throw new Error("Queue data is not an array");
        }
      }
    } catch (err) {
      console.error(`[D2 Workshop] Failed to load queue: ${err}`);
      // Preserve the corrupted file for recovery
      if (fs.existsSync(this.queueFile)) {
        const backupPath = this.queueFile + ".corrupted";
        try {
          fs.copyFileSync(this.queueFile, backupPath);
          console.warn(`[D2 Workshop] Corrupted queue saved to ${backupPath}`);
        } catch { /* ignore */ }
      }
      this.changes = [];
      vscode.window.showWarningMessage(
        "D2 Workshop: Failed to load pending changes. Queue has been reset."
      );
    }
  }

  private saveQueue(): void {
    try {
      fs.mkdirSync(this.queueDir, { recursive: true });
      // Write to temp file then rename for atomicity
      const tmpFile = this.queueFile + ".tmp";
      fs.writeFileSync(tmpFile, JSON.stringify(this.changes, null, 2));
      fs.renameSync(tmpFile, this.queueFile);
    } catch (err) {
      console.error(`[D2 Workshop] Failed to save queue: ${err}`);
    }
  }
}
