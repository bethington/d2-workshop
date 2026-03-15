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
  private readonly queueDir: string;
  private readonly queueFile: string;
  private readonly backupDir: string;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly workspaceRoot: string,
    private readonly mpqManager?: MpqManager
  ) {
    this.queueDir = path.join(workspaceRoot, ".d2workshop", "queue");
    this.queueFile = path.join(this.queueDir, "pending-changes.json");
    this.backupDir = path.join(workspaceRoot, ".d2workshop", "backups");
    this.loadQueue();
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
      // Create backups first
      await this.createBackups();

      // Apply MPQ changes
      const mpqChanges = this.changes.filter(
        (c): c is MpqFileChange => c.type === "mpq-file"
      );
      if (mpqChanges.length > 0) {
        await this.publishMpqChanges(mpqChanges);
      }

      // Apply binary global changes
      const binaryChanges = this.changes.filter(
        (c): c is BinaryGlobalChange => c.type === "binary-global"
      );
      if (binaryChanges.length > 0) {
        await this.publishBinaryChanges(binaryChanges);
      }

      this.clearQueue();
      vscode.window.showInformationMessage(
        `Successfully published ${mpqChanges.length + binaryChanges.length} change(s).`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Publish failed: ${err}`);
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

  private async publishMpqChanges(changes: MpqFileChange[]): Promise<void> {
    if (!this.mpqManager) {
      throw new Error("MPQ manager not available — cannot write to MPQ archives.");
    }

    for (const change of changes) {
      const uri = vscode.Uri.parse(change.uri);
      const mpqName = decodeURIComponent(uri.authority);
      const internalPath = uri.path.replace(/^\//, "");

      // Encode content as latin1 (D2 text file encoding)
      const data = Buffer.from(change.content, "latin1");

      this.mpqManager.writeFile(mpqName, internalPath, new Uint8Array(data));
      console.log(`[D2 Workshop] Published ${internalPath} to ${mpqName}`);
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
    const peOffset = peData.readUInt32LE(0x3c);
    const numSections = peData.readUInt16LE(peOffset + 6);
    const optHeaderSize = peData.readUInt16LE(peOffset + 20);
    const sectionTableOffset = peOffset + 24 + optHeaderSize;

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
        this.changes = JSON.parse(fs.readFileSync(this.queueFile, "utf-8"));
      }
    } catch {
      this.changes = [];
    }
  }

  private saveQueue(): void {
    fs.mkdirSync(this.queueDir, { recursive: true });
    fs.writeFileSync(this.queueFile, JSON.stringify(this.changes, null, 2));
  }
}
