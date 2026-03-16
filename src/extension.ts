import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { D2TreeProvider } from "./providers/d2-tree-provider";
import { MpqFileSystemProvider } from "./providers/mpq-filesystem";
import { TableEditorProvider } from "./providers/table-editor-provider";
import { DC6ViewerProvider } from "./providers/dc6-viewer-provider";
import { COFViewerProvider } from "./providers/cof-viewer-provider";
import { DT1ViewerProvider } from "./providers/dt1-viewer-provider";
import { PL2ViewerProvider } from "./providers/pl2-viewer-provider";
import { SearchProvider } from "./providers/search-provider";
import { BinaryEditorProvider } from "./providers/binary-editor-provider";
import { SaveQueueTreeProvider } from "./providers/save-queue-tree-provider";
import { SaveQueue } from "./mod/save-queue";
import { GameLauncher } from "./launch/game-launcher";
import { ModPackageManager } from "./mod/mod-package";
import { initStormLib } from "./mpq/stormlib-wasm";
import { MpqManager } from "./mpq/mpq-manager";
import { ModProfileManager } from "./mod/mod-profiles";

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

  // Register search view
  const searchProvider = new SearchProvider(mpqManager, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("d2SearchView", searchProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("d2workshop.searchMpq", async () => {
      const query = await vscode.window.showInputBox({
        placeHolder: "Search game files...",
        prompt: "Enter text to search across all MPQ file names, .txt tables, and .tbl strings",
      });
      if (query) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Searching for "${query}"...` },
          () => searchProvider.search(query)
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "d2workshop.openAndNavigate",
      async (uri: vscode.Uri, row: number) => {
        TableEditorProvider.pendingNavigation.set(uri.toString(), row);
        await vscode.commands.executeCommand("vscode.openWith", uri, "d2workshop.tableEditor");
      }
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
  context.subscriptions.push(
    COFViewerProvider.register(context, mpqManager)
  );
  context.subscriptions.push(
    DT1ViewerProvider.register(context, workspaceRoot)
  );
  context.subscriptions.push(
    PL2ViewerProvider.register(context)
  );

  // Initialize mod profile manager
  const modProfiles = new ModProfileManager(workspaceRoot);
  const activeRoot = modProfiles.activePath;

  // Point components at the active mod's root
  mpqManager.setRoot(activeRoot);
  treeProvider.setRoot(activeRoot);
  saveQueue.switchRoot(activeRoot, mpqManager);

  // Update tree view title to show active mod
  treeView.description = modProfiles.activeProfile.name;

  // Register commands
  const launcher = new GameLauncher(activeRoot);
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
    vscode.commands.registerCommand("d2workshop.switchMod", async () => {
      const profiles = modProfiles.getProfiles();
      const items = profiles.map((p) => ({
        label: p.name,
        description: p.isBase ? "Base installation" : p.rootPath,
        profile: p,
        picked: p.rootPath === modProfiles.activeProfile.rootPath,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a mod to work with",
        title: "Switch Mod",
      });

      if (!selected || selected.profile.rootPath === modProfiles.activeProfile.rootPath) return;

      // Close editors from the previous mod
      for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
        const input = tab.input as { uri?: vscode.Uri };
        if (input?.uri?.scheme === "d2mpq") {
          await vscode.window.tabGroups.close(tab);
        }
      }

      // Switch all components to the new mod
      const newRoot = selected.profile.rootPath;
      await modProfiles.switchProfile(selected.profile);
      mpqManager.setRoot(newRoot);
      treeProvider.setRoot(newRoot);
      saveQueue.switchRoot(newRoot, mpqManager);
      launcher.setRoot(newRoot);
      treeView.description = selected.profile.name;

      vscode.window.showInformationMessage(`Switched to: ${selected.profile.name}`);
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
