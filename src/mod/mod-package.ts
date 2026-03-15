import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SaveQueue } from "./save-queue";

export interface ModPackage {
  name: string;
  version: string;
  author: string;
  description: string;
  baseVersion: string;
  changes: {
    mpq?: Record<string, Record<string, { type: "full"; content: string }>>;
    binary?: Record<
      string,
      Array<{ rva: string; orig: string; patch: string; desc: string }>
    >;
  };
}

/**
 * Handles exporting and importing mod packages as JSON files.
 */
export class ModPackageManager {
  private readonly modsDir: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly saveQueue: SaveQueue
  ) {
    this.modsDir = path.join(workspaceRoot, ".d2workshop", "mods");
  }

  async exportMod(): Promise<void> {
    const changes = this.saveQueue.getChanges();
    if (changes.length === 0) {
      vscode.window.showInformationMessage(
        "No changes to export. Make some edits first."
      );
      return;
    }

    const name = await vscode.window.showInputBox({
      prompt: "Mod name",
      placeHolder: "My Awesome Mod",
    });
    if (!name) {
      return;
    }

    const description = await vscode.window.showInputBox({
      prompt: "Mod description",
      placeHolder: "What does this mod do?",
    });

    const author = await vscode.window.showInputBox({
      prompt: "Author name",
      placeHolder: "Your name",
    });

    const modPackage: ModPackage = {
      name,
      version: "1.0",
      author: author || "Unknown",
      description: description || "",
      baseVersion: "1.13c",
      changes: {},
    };

    // Build changes from queue
    for (const change of changes) {
      if (change.type === "mpq-file") {
        if (!modPackage.changes.mpq) {
          modPackage.changes.mpq = {};
        }
        const uri = vscode.Uri.parse(change.uri);
        const mpqName = uri.authority;
        const filePath = uri.path.replace(/^\//, "");

        if (!modPackage.changes.mpq[mpqName]) {
          modPackage.changes.mpq[mpqName] = {};
        }
        modPackage.changes.mpq[mpqName][filePath] = {
          type: "full",
          content: Buffer.from(change.content).toString("base64"),
        };
      }
    }

    // Include active patches from patch-state.json
    const patchStatePath = path.join(
      this.workspaceRoot,
      ".d2workshop",
      "patches",
      "patch-state.json"
    );
    if (fs.existsSync(patchStatePath)) {
      try {
        const patchState = JSON.parse(
          fs.readFileSync(patchStatePath, "utf-8")
        );
        modPackage.changes.binary = {};

        for (const [fileName, patches] of Object.entries(patchState)) {
          const activePatches = Object.entries(
            patches as Record<
              string,
              { enabled: boolean; origHex: string }
            >
          )
            .filter(([, state]) => state.enabled)
            .map(([rva, state]) => ({
              rva,
              orig: state.origHex,
              patch: "", // TODO: read current bytes from file
              desc: "",
            }));

          if (activePatches.length > 0) {
            modPackage.changes.binary[fileName] = activePatches;
          }
        }
      } catch {
        // Ignore patch state errors
      }
    }

    // Save mod package
    fs.mkdirSync(this.modsDir, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
    const modPath = path.join(this.modsDir, `${safeName}.json`);
    fs.writeFileSync(modPath, JSON.stringify(modPackage, null, 2));

    // Also offer to save elsewhere
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(modPath),
      filters: { "D2 Mod Package": ["json"] },
    });

    if (saveUri) {
      fs.writeFileSync(saveUri.fsPath, JSON.stringify(modPackage, null, 2));
      vscode.window.showInformationMessage(
        `Mod exported: ${saveUri.fsPath}`
      );
    } else {
      vscode.window.showInformationMessage(`Mod exported: ${modPath}`);
    }
  }

  async importMod(): Promise<void> {
    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "D2 Mod Package": ["json"] },
      openLabel: "Import Mod",
    });

    if (!fileUris || fileUris.length === 0) {
      return;
    }

    try {
      const content = fs.readFileSync(fileUris[0].fsPath, "utf-8");
      const modPackage: ModPackage = JSON.parse(content);

      if (!modPackage.name || !modPackage.changes) {
        vscode.window.showErrorMessage(
          "Invalid mod package: missing name or changes."
        );
        return;
      }

      // Show summary
      const mpqCount = modPackage.changes.mpq
        ? Object.values(modPackage.changes.mpq).reduce(
            (sum, files) => sum + Object.keys(files).length,
            0
          )
        : 0;
      const binaryCount = modPackage.changes.binary
        ? Object.values(modPackage.changes.binary).reduce(
            (sum, patches) => sum + patches.length,
            0
          )
        : 0;

      const confirm = await vscode.window.showInformationMessage(
        `Import "${modPackage.name}" by ${modPackage.author}?\n` +
          `${mpqCount} file change(s), ${binaryCount} binary patch(es)`,
        { modal: true },
        "Import",
        "Review Changes"
      );

      if (confirm === "Review Changes") {
        // TODO: Open mod-manager webview with conflict resolution UI
        vscode.window.showInformationMessage(
          "Conflict resolution UI coming soon."
        );
        return;
      }

      if (confirm !== "Import") {
        return;
      }

      // Apply MPQ changes to queue
      if (modPackage.changes.mpq) {
        for (const [mpqName, files] of Object.entries(
          modPackage.changes.mpq
        )) {
          for (const [filePath, fileData] of Object.entries(files)) {
            const decoded = Buffer.from(fileData.content, "base64").toString(
              "utf-8"
            );
            this.saveQueue.queueChange({
              type: "mpq-file",
              uri: `d2mpq://${mpqName}/${filePath}`,
              content: decoded,
            });
          }
        }
      }

      // Apply binary patches immediately
      if (modPackage.changes.binary) {
        for (const [fileName, patches] of Object.entries(
          modPackage.changes.binary
        )) {
          const filePath = path.join(this.workspaceRoot, fileName);
          if (!fs.existsSync(filePath)) {
            vscode.window.showWarningMessage(
              `Skipping ${fileName}: file not found`
            );
            continue;
          }

          // TODO: Apply patches with conflict detection
        }
      }

      vscode.window.showInformationMessage(
        `Imported "${modPackage.name}". ${mpqCount} file(s) added to save queue.`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to import mod: ${err}`);
    }
  }
}
