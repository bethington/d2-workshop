import * as vscode from "vscode";
import { MpqManager } from "../mpq/mpq-manager";
import { parseTBL } from "../dc6/tbl-parser";

type SearchResultLevel = "mpq" | "file" | "match";

export class SearchResultItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly level: SearchResultLevel,
    public readonly mpqName?: string,
    public readonly filePath?: string,
    public readonly matchLine?: number,
    public readonly matchText?: string,
  ) {
    super(label, collapsibleState);
    this.description = description;
  }
}

interface SearchMatch {
  mpqName: string;
  filePath: string;
  line: number;
  column: number;
  matchText: string;
  contextText: string;
}

export class SearchProvider implements vscode.TreeDataProvider<SearchResultItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SearchResultItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private results: SearchMatch[] = [];
  private lastQuery = "";
  private searching = false;

  constructor(
    private readonly mpqManager: MpqManager,
    private workspaceRoot: string
  ) {}

  setRoot(newRoot: string): void {
    this.workspaceRoot = newRoot;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SearchResultItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SearchResultItem): Promise<SearchResultItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    if (element.level === "mpq") {
      return this.getFileItems(element.mpqName!);
    }
    if (element.level === "file") {
      return this.getMatchItems(element.mpqName!, element.filePath!);
    }
    return [];
  }

  private getRootItems(): SearchResultItem[] {
    if (this.results.length === 0) {
      if (this.lastQuery) {
        return [new SearchResultItem(
          `No results for "${this.lastQuery}"`, "",
          vscode.TreeItemCollapsibleState.None, "match"
        )];
      }
      return [new SearchResultItem(
        "Click search icon to search", "",
        vscode.TreeItemCollapsibleState.None, "match"
      )];
    }

    // Group by MPQ
    const mpqGroups = new Map<string, number>();
    for (const r of this.results) {
      mpqGroups.set(r.mpqName, (mpqGroups.get(r.mpqName) || 0) + 1);
    }

    return Array.from(mpqGroups.entries()).map(([mpqName, count]) => {
      const item = new SearchResultItem(
        mpqName, `${count} match${count !== 1 ? "es" : ""}`,
        vscode.TreeItemCollapsibleState.Expanded, "mpq", mpqName
      );
      item.iconPath = new vscode.ThemeIcon("archive");
      return item;
    });
  }

  private getFileItems(mpqName: string): SearchResultItem[] {
    const fileGroups = new Map<string, number>();
    for (const r of this.results) {
      if (r.mpqName === mpqName) {
        fileGroups.set(r.filePath, (fileGroups.get(r.filePath) || 0) + 1);
      }
    }

    return Array.from(fileGroups.entries()).map(([filePath, count]) => {
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      const item = new SearchResultItem(
        fileName, `${count} match${count !== 1 ? "es" : ""}`,
        vscode.TreeItemCollapsibleState.Collapsed, "file", mpqName, filePath
      );
      item.iconPath = new vscode.ThemeIcon("file");
      return item;
    });
  }

  private getMatchItems(mpqName: string, filePath: string): SearchResultItem[] {
    return this.results
      .filter(r => r.mpqName === mpqName && r.filePath === filePath)
      .map(r => {
        const item = new SearchResultItem(
          r.contextText, `line ${r.line + 1}`,
          vscode.TreeItemCollapsibleState.None, "match",
          mpqName, filePath, r.line, r.matchText
        );
        item.iconPath = new vscode.ThemeIcon("search");

        // Click to open file
        const mpqUri = vscode.Uri.parse(
          `d2mpq://${encodeURIComponent(mpqName)}/${filePath.replace(/\\/g, "/")}`
        );
        const ext = filePath.split(".").pop()?.toLowerCase();
        if (ext === "txt" || ext === "tbl" || ext === "d2") {
          item.command = {
            command: "d2workshop.openAndNavigate",
            title: "Open and Navigate",
            arguments: [mpqUri, r.line],
          };
        }

        return item;
      });
  }

  /**
   * Search across all MPQ files for the given query.
   */
  async search(query: string): Promise<void> {
    if (!query || this.searching) return;

    this.searching = true;
    this.lastQuery = query;
    this.results = [];
    this.refresh();

    const queryLower = query.toLowerCase();

    try {
      const mpqFiles = this.mpqManager.getMpqFiles();

      for (const mpqName of mpqFiles) {
        let fileList: string[];
        try {
          fileList = this.mpqManager.getFileList(mpqName);
        } catch {
          continue;
        }

        // Search file names
        for (const filePath of fileList) {
          if (filePath.toLowerCase().includes(queryLower)) {
            this.results.push({
              mpqName, filePath, line: 0, column: 0,
              matchText: query,
              contextText: `[filename] ${filePath}`,
            });
          }
        }

        // Search text file contents (.txt)
        const textFiles = fileList.filter(f => f.toLowerCase().endsWith(".txt"));
        for (const filePath of textFiles) {
          try {
            const data = this.mpqManager.readFile(mpqName, filePath);
            const text = new TextDecoder("latin1").decode(data);
            const lines = text.split(/\r?\n/);

            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
              const line = lines[lineIdx];
              const lowerLine = line.toLowerCase();
              let searchFrom = 0;

              while (true) {
                const col = lowerLine.indexOf(queryLower, searchFrom);
                if (col === -1) break;

                // Truncate context for display
                const start = Math.max(0, col - 20);
                const end = Math.min(line.length, col + query.length + 20);
                let context = line.substring(start, end).trim();
                if (start > 0) context = "..." + context;
                if (end < line.length) context = context + "...";

                this.results.push({
                  mpqName, filePath, line: lineIdx, column: col,
                  matchText: query, contextText: context,
                });

                searchFrom = col + 1;
              }
            }
          } catch {
            // Skip files that can't be read
          }
        }

        // Search TBL string contents
        const tblFiles = fileList.filter(f => f.toLowerCase().endsWith(".tbl"));
        for (const filePath of tblFiles) {
          try {
            const data = this.mpqManager.readFile(mpqName, filePath);
            const tbl = parseTBL(data);

            for (let i = 0; i < tbl.entries.length; i++) {
              const entry = tbl.entries[i];
              if (entry.key.toLowerCase().includes(queryLower) ||
                  entry.value.toLowerCase().includes(queryLower)) {
                const context = `${entry.key}: ${entry.value.substring(0, 60)}`;
                this.results.push({
                  mpqName, filePath, line: i, column: 0,
                  matchText: query,
                  contextText: context.length > 80 ? context.substring(0, 77) + "..." : context,
                });
              }
            }
          } catch {
            // Skip files that can't be parsed
          }
        }
      }
    } finally {
      this.searching = false;
    }

    this.refresh();
  }
}
