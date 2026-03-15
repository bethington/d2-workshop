import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SaveQueue } from "../mod/save-queue";
import { getWebviewContent } from "./webview-utils";
import { parsePE, readAtRva, PESection } from "../binary/pe-reader";
import {
  BinarySchema,
  loadBinarySchema,
  mergeSchemas,
} from "../binary/globals-schema";

interface PEInfoForWebview {
  fileName: string;
  fileSize: number;
  imageBase: string;
  entryPoint: string;
  is64Bit: boolean;
  sections: Array<{
    name: string;
    virtualAddress: string;
    virtualSize: string;
    rawSize: string;
  }>;
  exports: Array<{ name: string; ordinal: number; rva: string }>;
}

export class BinaryEditorProvider
  implements vscode.CustomReadonlyEditorProvider
{
  private static readonly viewType = "d2workshop.binaryEditor";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly saveQueue: SaveQueue
  ) {}

  static register(
    context: vscode.ExtensionContext,
    saveQueue: SaveQueue
  ): vscode.Disposable {
    const provider = new BinaryEditorProvider(context, saveQueue);
    return vscode.window.registerCustomEditorProvider(
      BinaryEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "webviews"),
      ],
    };

    webviewPanel.webview.html = getWebviewContent(
      webviewPanel.webview,
      this.context.extensionUri,
      "binary-editor"
    );

    const filePath = document.uri.fsPath;
    const fileName = path.basename(filePath);
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";

    // Parse PE and load schema
    let peInfo: PEInfoForWebview | null = null;
    let schema: BinarySchema | null = null;
    let patchState: Record<string, { enabled: boolean; origHex: string }> = {};
    let sections: PESection[] = [];
    let error: string | null = null;

    try {
      console.log(`[D2 Workshop] Loading binary: ${filePath}`);
      const binaryData = new Uint8Array(fs.readFileSync(filePath));
      const pe = parsePE(binaryData);
      sections = pe.sections;

      peInfo = {
        fileName,
        fileSize: binaryData.length,
        imageBase: `0x${pe.imageBase.toString(16).toUpperCase()}`,
        entryPoint: `0x${pe.entryPoint.toString(16).toUpperCase()}`,
        is64Bit: pe.is64Bit,
        sections: pe.sections.map((s) => ({
          name: s.name,
          virtualAddress: `0x${s.virtualAddress.toString(16).toUpperCase()}`,
          virtualSize: `0x${s.virtualSize.toString(16).toUpperCase()}`,
          rawSize: `0x${s.rawDataSize.toString(16).toUpperCase()}`,
        })),
        exports: pe.exports.slice(0, 200).map((e) => ({
          name: e.name,
          ordinal: e.ordinal,
          rva: `0x${e.rva.toString(16).toUpperCase()}`,
        })),
      };

      // Load schema — try workspace then bundled
      const bundled = loadBinarySchema(
        this.context.extensionUri.fsPath,
        workspaceRoot,
        fileName
      );
      schema = bundled;

      // Read current values for globals
      if (schema) {
        for (const category of Object.keys(schema.globals)) {
          for (const entry of schema.globals[category]) {
            const rva = parseInt(entry.rva, 16);
            const size =
              entry.type === "byte"
                ? 1
                : entry.type === "word"
                  ? 2
                  : 4;
            const value = readAtRva(binaryData, rva, size, sections);
            (entry as any).currentValue = value;
          }
        }

        // Check current patch state against actual bytes
        for (const group of schema.patchGroups) {
          for (const [dllName, patches] of Object.entries(group.dlls)) {
            if (dllName.toLowerCase() !== fileName.toLowerCase()) continue;
            for (const patch of patches) {
              const rva = parseInt(patch.rva, 16);
              const patchBytes = Buffer.from(patch.patch, "hex");
              const size = patchBytes.length;
              const offset = this.rvaToFileOffset(
                Buffer.from(binaryData),
                rva
              );
              if (offset >= 0) {
                const current = binaryData.slice(offset, offset + size);
                const isPatched = Buffer.from(current).equals(patchBytes);
                (patch as any)._currentlyApplied = isPatched;
              }
            }
          }
        }
      }

      // Load saved patch state
      const allPatchState = this.loadPatchState(workspaceRoot);
      patchState = allPatchState[fileName] || {};

      console.log(
        `[D2 Workshop] Binary loaded: ${pe.sections.length} sections, ` +
          `${pe.exports.length} exports, schema=${!!schema}`
      );
    } catch (err) {
      console.error(`[D2 Workshop] Failed to parse binary: ${err}`);
      error = String(err);
    }

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready": {
          console.log(
            `[D2 Workshop] Binary webview ready, sending ${fileName}`
          );
          webviewPanel.webview.postMessage({
            type: "load",
            fileName,
            filePath,
            peInfo,
            schema,
            patchState,
            error,
          });
          break;
        }
        case "togglePatch": {
          await this.togglePatch(
            filePath,
            message.patch,
            message.enabled,
            workspaceRoot
          );
          // Re-read and check state
          const updated = new Uint8Array(fs.readFileSync(filePath));
          const patchRva = parseInt(message.patch.rva, 16);
          const patchSize = message.patch.patch.length / 2;
          const offset = this.rvaToFileOffset(
            Buffer.from(updated),
            patchRva
          );
          const currentHex =
            offset >= 0
              ? Buffer.from(updated.slice(offset, offset + patchSize)).toString(
                  "hex"
                )
              : "";
          webviewPanel.webview.postMessage({
            type: "patchResult",
            rva: message.patch.rva,
            enabled: message.enabled,
            currentHex,
          });
          break;
        }
        case "editGlobal": {
          this.saveQueue.queueChange({
            type: "binary-global",
            filePath,
            rva: message.rva,
            value: message.value,
            size: message.size,
          });
          vscode.window.showInformationMessage(
            `Global edit queued. Use "Publish" to apply.`
          );
          break;
        }
      }
    });
  }

  private loadPatchState(
    workspaceRoot: string
  ): Record<
    string,
    Record<string, { enabled: boolean; origHex: string }>
  > {
    const statePath = path.join(
      workspaceRoot,
      ".d2workshop",
      "patches",
      "patch-state.json"
    );
    try {
      if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, "utf-8"));
      }
    } catch {
      // Ignore
    }
    return {};
  }

  private async togglePatch(
    filePath: string,
    patch: { rva: string; orig: string; patch: string; desc: string },
    enabled: boolean,
    workspaceRoot: string
  ): Promise<void> {
    const rva = parseInt(patch.rva, 16);
    const bytes = enabled ? patch.patch : patch.orig;
    const data = Buffer.from(bytes, "hex");

    const fileData = Buffer.from(fs.readFileSync(filePath));
    const offset = this.rvaToFileOffset(fileData, rva);

    if (offset < 0 || offset + data.length > fileData.length) {
      vscode.window.showErrorMessage(
        `Patch failed: RVA 0x${rva.toString(16)} out of bounds`
      );
      return;
    }

    // Verify expected bytes
    const origBytes = Buffer.from(enabled ? patch.orig : patch.patch, "hex");
    const currentBytes = fileData.subarray(offset, offset + origBytes.length);
    if (!currentBytes.equals(origBytes)) {
      vscode.window.showErrorMessage(
        `Patch verification failed at RVA 0x${rva.toString(16)}: ` +
          `expected ${origBytes.toString("hex")}, got ${currentBytes.toString("hex")}`
      );
      return;
    }

    // Auto-backup before first patch
    const backupDir = path.join(workspaceRoot, ".d2workshop", "backups");
    const backupPath = path.join(
      backupDir,
      path.basename(filePath) + ".bak"
    );
    if (!fs.existsSync(backupPath)) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(filePath, backupPath);
      console.log(`[D2 Workshop] Backup created: ${backupPath}`);
    }

    // Apply
    data.copy(fileData, offset);
    fs.writeFileSync(filePath, fileData);

    // Save state
    this.savePatchState(workspaceRoot, filePath, patch.rva, enabled, patch.orig);

    const action = enabled ? "Applied" : "Reverted";
    vscode.window.showInformationMessage(`${action}: ${patch.desc}`);
  }

  private savePatchState(
    workspaceRoot: string,
    filePath: string,
    rva: string,
    enabled: boolean,
    origHex: string
  ): void {
    const stateDir = path.join(workspaceRoot, ".d2workshop", "patches");
    const statePath = path.join(stateDir, "patch-state.json");
    fs.mkdirSync(stateDir, { recursive: true });

    let state: Record<
      string,
      Record<string, { enabled: boolean; origHex: string }>
    > = {};
    try {
      if (fs.existsSync(statePath)) {
        state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      }
    } catch {
      // Fresh
    }

    const fileName = path.basename(filePath);
    if (!state[fileName]) state[fileName] = {};
    state[fileName][rva] = { enabled, origHex };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
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
}
