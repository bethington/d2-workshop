import * as vscode from "vscode";
import { SaveQueue, QueuedChange, MpqFileChange, BinaryGlobalChange, CellDiff } from "../mod/save-queue";

type TreeItemLevel = "file" | "row" | "change";

export class SaveQueueTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly level: TreeItemLevel,
    public readonly changeIndex?: number,
    public readonly rowName?: string,
    public readonly filePath?: string,
  ) {
    super(label, collapsibleState);
    this.description = description;
  }
}

/**
 * Tree view provider for the save queue panel.
 * Shows a 3-level tree:
 *   File → Row/Address → Individual changes
 */
export class SaveQueueTreeProvider
  implements vscode.TreeDataProvider<SaveQueueTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    SaveQueueTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly saveQueue: SaveQueue) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SaveQueueTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: SaveQueueTreeItem
  ): Promise<SaveQueueTreeItem[]> {
    const changes = this.saveQueue.getChanges();

    if (!element) {
      // Root level: group by file
      return this.getFileItems(changes);
    }

    if (element.level === "file") {
      // Second level: show rows (for MPQ) or individual changes (for binary)
      return this.getRowItems(element, changes);
    }

    if (element.level === "row") {
      // Third level: show individual column changes
      return this.getChangeItems(element, changes);
    }

    return [];
  }

  private getFileItems(changes: readonly QueuedChange[]): SaveQueueTreeItem[] {
    if (changes.length === 0) {
      return [
        new SaveQueueTreeItem(
          "No pending changes",
          "",
          vscode.TreeItemCollapsibleState.None,
          "change"
        ),
      ];
    }

    // Group MPQ changes by URI, binary changes by filePath
    const fileItems: SaveQueueTreeItem[] = [];

    // Group binary changes by file
    const binaryByFile = new Map<string, { changes: BinaryGlobalChange[]; indices: number[] }>();

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];

      if (change.type === "mpq-file") {
        const uri = change.uri;
        const parts = uri.split("/");
        const fileName = parts[parts.length - 1];
        const mpqName = uri.includes("://")
          ? decodeURIComponent(uri.split("://")[1]?.split("/")[0] || "")
          : "";

        const diffCount = change.diffs?.length || 0;
        const desc = mpqName
          ? `${mpqName} • ${diffCount} change${diffCount !== 1 ? "s" : ""}`
          : `${diffCount} change${diffCount !== 1 ? "s" : ""}`;

        const item = new SaveQueueTreeItem(
          fileName,
          desc,
          diffCount > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
          "file",
          i,
          undefined,
          uri
        );
        item.iconPath = new vscode.ThemeIcon("file");
        item.contextValue = "queuedChange";
        fileItems.push(item);
      } else {
        const key = change.filePath;
        if (!binaryByFile.has(key)) {
          binaryByFile.set(key, { changes: [], indices: [] });
        }
        binaryByFile.get(key)!.changes.push(change);
        binaryByFile.get(key)!.indices.push(i);
      }
    }

    // Add grouped binary file items
    for (const [filePath, group] of binaryByFile) {
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      const item = new SaveQueueTreeItem(
        fileName,
        `${group.changes.length} patch${group.changes.length !== 1 ? "es" : ""}`,
        vscode.TreeItemCollapsibleState.Collapsed,
        "file",
        group.indices[0],
        undefined,
        filePath
      );
      item.iconPath = new vscode.ThemeIcon("file-binary");
      item.contextValue = "queuedChange";
      fileItems.push(item);
    }

    return fileItems;
  }

  private getRowItems(
    parent: SaveQueueTreeItem,
    changes: readonly QueuedChange[]
  ): SaveQueueTreeItem[] {
    if (parent.changeIndex === undefined) return [];
    const change = changes[parent.changeIndex];

    if (change?.type === "mpq-file" && change.diffs && change.diffs.length > 0) {
      // Group diffs by row name
      const rowMap = new Map<string, CellDiff[]>();
      for (const diff of change.diffs) {
        if (!rowMap.has(diff.rowName)) {
          rowMap.set(diff.rowName, []);
        }
        rowMap.get(diff.rowName)!.push(diff);
      }

      return Array.from(rowMap.entries()).map(([rowName, diffs]) => {
        const item = new SaveQueueTreeItem(
          rowName,
          `${diffs.length} change${diffs.length !== 1 ? "s" : ""}`,
          vscode.TreeItemCollapsibleState.Collapsed,
          "row",
          parent.changeIndex,
          rowName,
          parent.filePath
        );
        item.iconPath = new vscode.ThemeIcon("symbol-object");
        return item;
      });
    }

    // Binary changes grouped under this file
    const binaryItems: SaveQueueTreeItem[] = [];
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      if (c.type === "binary-global" && c.filePath === parent.filePath) {
        const item = new SaveQueueTreeItem(
          `0x${c.rva.toString(16).toUpperCase()}`,
          `${c.value} (${c.size} byte${c.size !== 1 ? "s" : ""})`,
          vscode.TreeItemCollapsibleState.None,
          "change",
          i
        );
        item.iconPath = new vscode.ThemeIcon("symbol-variable");
        item.contextValue = "queuedChange";
        binaryItems.push(item);
      }
    }
    return binaryItems;
  }

  private getChangeItems(
    parent: SaveQueueTreeItem,
    changes: readonly QueuedChange[]
  ): SaveQueueTreeItem[] {
    if (parent.changeIndex === undefined || !parent.rowName) return [];
    const change = changes[parent.changeIndex];

    if (change?.type === "mpq-file" && change.diffs) {
      return change.diffs
        .filter((d) => d.rowName === parent.rowName)
        .map((diff) => {
          const item = new SaveQueueTreeItem(
            diff.column,
            `${diff.oldValue} → ${diff.newValue}`,
            vscode.TreeItemCollapsibleState.None,
            "change",
            parent.changeIndex
          );
          item.iconPath = new vscode.ThemeIcon("diff-modified");
          return item;
        });
    }

    return [];
  }
}
