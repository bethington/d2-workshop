import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { D2TreeProvider } from "./providers/d2-tree-provider";
import { MpqFileSystemProvider } from "./providers/mpq-filesystem";
import { TableEditorProvider } from "./providers/table-editor-provider";
import { DC6ViewerProvider } from "./providers/dc6-viewer-provider";
import { BinaryEditorProvider } from "./providers/binary-editor-provider";
import { SaveQueueTreeProvider } from "./providers/save-queue-tree-provider";
import { SaveQueue } from "./mod/save-queue";
import { GameLauncher } from "./launch/game-launcher";
import { ModPackageManager } from "./mod/mod-package";
import { initStormLib } from "./mpq/stormlib-wasm";
import { MpqManager } from "./mpq/mpq-manager";

let saveQueue: SaveQueue;
let mpqManager: MpqManager;

export async function activate(context: vscode.ExtensionContext) {
  console.log("D2 Workshop is activating...");

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

  // Initialize StormLib (tries native DLL, then WASM, then stub)
  try {
    await initStormLib(context.extensionUri.fsPath);
  } catch (err) {
    console.warn(`[D2 Workshop] StormLib init failed: ${err}`);
  }

  // Initialize MPQ manager
  mpqManager = new MpqManager(workspaceRoot);

  // Initialize save queue
  saveQueue = new SaveQueue(workspaceRoot, mpqManager);

  // Register MPQ virtual filesystem
  const mpqFs = new MpqFileSystemProvider(mpqManager);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("d2mpq", mpqFs, {
      isCaseSensitive: false,
      isReadonly: false,
    })
  );

  // Register D2 Explorer tree view
  const treeProvider = new D2TreeProvider(workspaceRoot, mpqManager);
  const treeView = vscode.window.createTreeView("d2ExplorerView", {
    treeDataProvider: treeProvider,
  });
  context.subscriptions.push(treeView);

  // Register Save Queue tree view
  const queueTreeProvider = new SaveQueueTreeProvider(saveQueue);
  context.subscriptions.push(
    saveQueue.onDidChange(() => queueTreeProvider.refresh())
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "d2SaveQueueView",
      queueTreeProvider
    )
  );

  // Register custom editors
  context.subscriptions.push(
    TableEditorProvider.register(context, saveQueue)
  );
  context.subscriptions.push(
    DC6ViewerProvider.register(context, workspaceRoot)
  );
  context.subscriptions.push(
    BinaryEditorProvider.register(context, saveQueue)
  );

  // Register commands
  const launcher = new GameLauncher(workspaceRoot);
  const modManager = new ModPackageManager(workspaceRoot, saveQueue);

  context.subscriptions.push(
    vscode.commands.registerCommand("d2workshop.publishQueue", async () => {
      await saveQueue.publish();
      queueTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("d2workshop.launchGame", () =>
      launcher.launch()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("d2workshop.exportMod", () =>
      modManager.exportMod()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("d2workshop.importMod", async () => {
      await modManager.importMod();
      queueTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "d2workshop.removeQueueItem",
      (item: { changeIndex?: number }) => {
        if (item.changeIndex !== undefined) {
          saveQueue.removeChange(item.changeIndex);
          queueTreeProvider.refresh();
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("d2workshop.clearQueue", () => {
      saveQueue.clearQueue();
      queueTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("d2workshop.refreshQueue", () => {
      queueTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("d2workshop.revealInExplorer", (uri?: vscode.Uri) => {
      const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
      if (!targetUri || targetUri.scheme !== "d2mpq") return;

      const mpqName = decodeURIComponent(targetUri.authority);
      const internalPath = targetUri.path.replace(/^\//, "");
      const item = treeProvider.findItem(mpqName, internalPath);
      if (item) {
        treeView.reveal(item, { select: true, focus: true, expand: true });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "d2workshop.restoreBackup",
      async (item: { filePath?: string; label?: string }) => {
        if (!item?.filePath) return;
        const fileName = item.label || path.basename(item.filePath);
        const backupPath = path.join(
          workspaceRoot,
          ".d2workshop",
          "backups",
          fileName + ".bak"
        );

        if (!fs.existsSync(backupPath)) {
          vscode.window.showErrorMessage(`No backup found for ${fileName}.`);
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Restore ${fileName} from backup? The current file will be overwritten.`,
          { modal: true },
          "Restore"
        );
        if (confirm !== "Restore") return;

        fs.copyFileSync(backupPath, item.filePath);
        saveQueue.clearQueue();
        treeProvider.refresh();
        vscode.window.showInformationMessage(
          `Restored ${fileName} from backup. Save queue cleared.`
        );
      }
    )
  );

  // Refresh tree when files change
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{mpq,dll,exe}"
  );
  watcher.onDidChange(() => treeProvider.refresh());
  watcher.onDidCreate(() => treeProvider.refresh());
  watcher.onDidDelete(() => treeProvider.refresh());
  context.subscriptions.push(watcher);

  // Cleanup on deactivation
  context.subscriptions.push(
    new vscode.Disposable(() => {
      mpqManager.closeAll();
    })
  );

  console.log("D2 Workshop activated successfully");
}

export function deactivate() {
  if (mpqManager) {
    mpqManager.closeAll();
  }
  console.log("D2 Workshop deactivated");
}
