import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { MpqManager } from "../mpq/mpq-manager";

export enum D2FileType {
  Folder = "folder",
  Mpq = "mpq",
  Dll = "dll",
  Exe = "exe",
  Txt = "txt",
  Dc6 = "dc6",
  Dcc = "dcc",
  Cof = "cof",
  Dt1 = "dt1",
  Ds1 = "ds1",
  Pl2 = "pl2",
  Dat = "dat",
  D2 = "d2",
  Bin = "bin",
  Tbl = "tbl",
  Unknown = "unknown",
}

export class D2TreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly fileType: D2FileType,
    public readonly filePath: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly mpqName?: string,
    public readonly mpqInternalPath?: string
  ) {
    super(label, collapsibleState);
    this.tooltip = mpqInternalPath
      ? `${mpqName}/${mpqInternalPath}`
      : filePath;
    this.contextValue = fileType;

    switch (fileType) {
      case D2FileType.Mpq:
        this.iconPath = new vscode.ThemeIcon("archive");
        break;
      case D2FileType.Dll:
      case D2FileType.Exe:
        this.iconPath = new vscode.ThemeIcon("file-binary");
        break;
      case D2FileType.Txt:
        this.iconPath = new vscode.ThemeIcon("table");
        break;
      case D2FileType.Dc6:
      case D2FileType.Dcc:
      case D2FileType.Dt1:
        this.iconPath = new vscode.ThemeIcon("file-media");
        break;
      case D2FileType.Cof:
      case D2FileType.D2:
        this.iconPath = new vscode.ThemeIcon("symbol-event");
        break;
      case D2FileType.Ds1:
        this.iconPath = new vscode.ThemeIcon("map");
        break;
      case D2FileType.Pl2:
      case D2FileType.Dat:
        this.iconPath = new vscode.ThemeIcon("symbol-color");
        break;
      case D2FileType.Bin:
        this.iconPath = new vscode.ThemeIcon("file-code");
        break;
      case D2FileType.Tbl:
        this.iconPath = new vscode.ThemeIcon("symbol-string");
        break;
      case D2FileType.Folder:
        this.iconPath = vscode.ThemeIcon.Folder;
        break;
      default:
        this.iconPath = vscode.ThemeIcon.File;
    }

    // Set command for openable file types
    if (mpqName && mpqInternalPath) {
      const mpqUri = vscode.Uri.parse(
        `d2mpq://${encodeURIComponent(mpqName)}/${mpqInternalPath}`
      );

      if (fileType === D2FileType.Txt || fileType === D2FileType.Tbl) {
        this.command = {
          command: "vscode.openWith",
          title: "Open Table",
          arguments: [mpqUri, "d2workshop.tableEditor"],
        };
      } else if (fileType === D2FileType.Dc6 || fileType === D2FileType.Dcc) {
        this.command = {
          command: "vscode.openWith",
          title: "Open Sprite",
          arguments: [mpqUri, "d2workshop.dc6Viewer"],
        };
      } else if (fileType === D2FileType.Cof) {
        this.command = {
          command: "vscode.openWith",
          title: "Open COF",
          arguments: [mpqUri, "d2workshop.cofViewer"],
        };
      } else if (fileType === D2FileType.Dt1) {
        this.command = {
          command: "vscode.openWith",
          title: "Open Tiles",
          arguments: [mpqUri, "d2workshop.dt1Viewer"],
        };
      } else if (fileType === D2FileType.Pl2) {
        this.command = {
          command: "vscode.openWith",
          title: "Open Palette",
          arguments: [mpqUri, "d2workshop.pl2Viewer"],
        };
      }
    } else if (fileType === D2FileType.Dll || fileType === D2FileType.Exe) {
      this.command = {
        command: "vscode.openWith",
        title: "Open Binary",
        arguments: [vscode.Uri.file(filePath), "d2workshop.binaryEditor"],
      };
    }
  }
}

const DISK_FILE_TYPES: Record<string, D2FileType> = {
  ".mpq": D2FileType.Mpq,
  ".dll": D2FileType.Dll,
  ".exe": D2FileType.Exe,
};

function detectMpqFileType(fileName: string): D2FileType {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".txt":
      return D2FileType.Txt;
    case ".dc6":
      return D2FileType.Dc6;
    case ".dcc":
      return D2FileType.Dcc;
    case ".cof":
      return D2FileType.Cof;
    case ".dt1":
      return D2FileType.Dt1;
    case ".ds1":
      return D2FileType.Ds1;
    case ".pl2":
      return D2FileType.Pl2;
    case ".dat":
      return D2FileType.Dat;
    case ".d2":
      return D2FileType.D2;
    case ".bin":
      return D2FileType.Bin;
    case ".tbl":
      return D2FileType.Tbl;
    default:
      return D2FileType.Unknown;
  }
}

export class D2TreeProvider implements vscode.TreeDataProvider<D2TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    D2TreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private workspaceRoot: string,
    private readonly mpqManager: MpqManager
  ) {}

  setRoot(newRoot: string): void {
    this.workspaceRoot = newRoot;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: D2TreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: D2TreeItem): D2TreeItem | null {
    if (!element.mpqName) return null;

    if (!element.mpqInternalPath) {
      // This is a top-level MPQ entry, parent is the MPQ root item
      return null;
    }

    const parentPath = element.mpqInternalPath.replace(/[/\\][^/\\]+$/, "");
    if (!parentPath || parentPath === element.mpqInternalPath) {
      // Parent is the MPQ root
      const mpqFilePath = path.join(this.workspaceRoot, element.mpqName);
      return new D2TreeItem(
        element.mpqName,
        D2FileType.Mpq,
        mpqFilePath,
        vscode.TreeItemCollapsibleState.Collapsed
      );
    }

    const parentName = parentPath.split(/[/\\]/).pop() || parentPath;
    return new D2TreeItem(
      parentName,
      D2FileType.Folder,
      "",
      vscode.TreeItemCollapsibleState.Collapsed,
      element.mpqName,
      parentPath
    );
  }

  /**
   * Find a tree item by MPQ name and internal path, building the
   * ancestor chain so reveal() can expand the tree to it.
   */
  findItem(mpqName: string, internalPath: string): D2TreeItem | null {
    const fileName = internalPath.split(/[/\\]/).pop() || internalPath;
    const fileType = detectMpqFileType(fileName);
    return new D2TreeItem(
      fileName,
      fileType,
      "",
      vscode.TreeItemCollapsibleState.None,
      mpqName,
      internalPath
    );
  }

  async getChildren(element?: D2TreeItem): Promise<D2TreeItem[]> {
    if (!element) {
      return this.getRootItems();
    }

    if (element.fileType === D2FileType.Mpq) {
      return this.getMpqTopLevel(element.label);
    }

    if (element.fileType === D2FileType.Folder && element.mpqName) {
      return this.getMpqFolderContents(
        element.mpqName,
        element.mpqInternalPath!
      );
    }

    return [];
  }

  private getRootItems(): D2TreeItem[] {
    const items: D2TreeItem[] = [];

    try {
      const entries = fs.readdirSync(this.workspaceRoot, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        const fileType = DISK_FILE_TYPES[ext];
        if (!fileType) continue;

        const fullPath = path.join(this.workspaceRoot, entry.name);
        const collapsible =
          fileType === D2FileType.Mpq
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const item = new D2TreeItem(entry.name, fileType, fullPath, collapsible);
        // Check if backup exists for this file
        const backupPath = path.join(this.workspaceRoot, ".d2workshop", "backups", entry.name + ".bak");
        if (fs.existsSync(backupPath)) {
          item.contextValue = fileType + "_hasBackup";
        }
        items.push(item);
      }
    } catch {
      // Workspace may not be accessible
    }

    // Sort: MPQs first, then EXEs, then DLLs
    const order: Record<string, number> = { mpq: 0, exe: 1, dll: 2 };
    items.sort((a, b) => {
      const oa = order[a.fileType] ?? 9;
      const ob = order[b.fileType] ?? 9;
      return oa !== ob ? oa - ob : a.label.localeCompare(b.label);
    });

    return items;
  }

  private getMpqTopLevel(mpqName: string): D2TreeItem[] {
    try {
      const entries = this.mpqManager.listDirectory(mpqName, "");
      return entries.map((entry) => {
        if (entry.isDirectory) {
          return new D2TreeItem(
            entry.name,
            D2FileType.Folder,
            "",
            vscode.TreeItemCollapsibleState.Collapsed,
            mpqName,
            entry.fullPath
          );
        }

        const fileType = detectMpqFileType(entry.name);
        return new D2TreeItem(
          entry.name,
          fileType,
          "",
          vscode.TreeItemCollapsibleState.None,
          mpqName,
          entry.fullPath
        );
      });
    } catch (err) {
      // StormLib not available — show placeholder
      return [
        new D2TreeItem(
          `(StormLib required: ${err})`,
          D2FileType.Unknown,
          "",
          vscode.TreeItemCollapsibleState.None
        ),
      ];
    }
  }

  private getMpqFolderContents(
    mpqName: string,
    internalPath: string
  ): D2TreeItem[] {
    try {
      const entries = this.mpqManager.listDirectory(mpqName, internalPath);
      return entries.map((entry) => {
        if (entry.isDirectory) {
          return new D2TreeItem(
            entry.name,
            D2FileType.Folder,
            "",
            vscode.TreeItemCollapsibleState.Collapsed,
            mpqName,
            entry.fullPath
          );
        }

        const fileType = detectMpqFileType(entry.name);
        return new D2TreeItem(
          entry.name,
          fileType,
          "",
          vscode.TreeItemCollapsibleState.None,
          mpqName,
          entry.fullPath
        );
      });
    } catch {
      return [];
    }
  }
}
