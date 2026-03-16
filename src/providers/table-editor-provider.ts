import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SaveQueue, computeTableDiffs } from "../mod/save-queue";
import { getWebviewContent } from "./webview-utils";
import { parseTBL, encodeTBL, tblToTabDelimited, tabDelimitedToTbl } from "../dc6/tbl-parser";

interface TxtSchema {
  file: string;
  description: string;
  columns: Record<
    string,
    {
      type: string;
      required?: boolean;
      unique?: boolean;
      min?: number;
      max?: number;
      values?: string[];
      target?: string;
      targetColumn?: string;
      assetType?: string;
      basePath?: string;
      description?: string;
    }
  >;
}

/**
 * Custom editor provider for D2 tab-delimited .txt files.
 * Works with both regular files and d2mpq:// virtual files.
 */
export class TableEditorProvider
  implements vscode.CustomReadonlyEditorProvider
{
  private static readonly viewType = "d2workshop.tableEditor";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly saveQueue: SaveQueue
  ) {}

  static register(
    context: vscode.ExtensionContext,
    saveQueue: SaveQueue
  ): vscode.Disposable {
    const provider = new TableEditorProvider(context, saveQueue);
    return vscode.window.registerCustomEditorProvider(
      TableEditorProvider.viewType,
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
      "table-editor"
    );

    // Pre-load the data while webview initializes
    const fileName = this.getFileName(document.uri);
    const schema = this.loadSchema(fileName);
    const isTbl = fileName.toLowerCase().endsWith(".tbl");
    let text: string;

    try {
      console.log(
        `[D2 Workshop] Loading table: ${document.uri.toString()}`
      );
      const data = await vscode.workspace.fs.readFile(document.uri);

      if (isTbl) {
        // Parse binary TBL and convert to tab-delimited for the editor
        const tbl = parseTBL(data);
        text = tblToTabDelimited(tbl.entries);
        console.log(
          `[D2 Workshop] TBL parsed: ${tbl.entries.length} string entries for ${fileName}`
        );
      } else {
        text = new TextDecoder("latin1").decode(data);
        console.log(
          `[D2 Workshop] Loaded ${text.length} bytes for ${fileName}`
        );
      }
    } catch (err) {
      console.error(`[D2 Workshop] Failed to load table: ${err}`);
      text = `Error loading file: ${err}`;
    }

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case "ready": {
          // Webview is ready to receive data — send it now
          console.log(`[D2 Workshop] Webview ready, sending ${fileName}`);
          webviewPanel.webview.postMessage({
            type: "load",
            content: text,
            fileName,
            schema,
          });
          break;
        }
        case "save": {
          let contentToSave = message.content as string;

          if (isTbl) {
            // Convert tab-delimited back to TBL binary, then base64 for queue storage
            const tblEntries = tabDelimitedToTbl(contentToSave);
            const tblBinary = encodeTBL(tblEntries);
            contentToSave = Buffer.from(tblBinary).toString("base64");
          }

          // Normalize original through same parse/serialize pipeline
          const normalizedOriginal = this.normalizeTabContent(text);
          const diffs = computeTableDiffs(normalizedOriginal, message.content);
          this.saveQueue.queueChange({
            type: "mpq-file",
            uri: document.uri.toString(),
            content: contentToSave,
            diffs,
            isBinary: isTbl,
          });
          vscode.window.showInformationMessage(
            `${fileName} queued for save (${diffs.length} change${diffs.length !== 1 ? "s" : ""}). Use "Publish" to write to MPQ.`
          );
          break;
        }
        case "requestSchema": {
          const s = this.loadSchema(message.fileName);
          webviewPanel.webview.postMessage({
            type: "schema",
            schema: s,
          });
          break;
        }
      }
    });
  }

  /**
   * Normalize tab-delimited content through the same parse/serialize pipeline
   * the webview uses, so that diffs only reflect actual user edits.
   */
  private normalizeTabContent(raw: string): string {
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return "";

    const headers = lines[0].split("\t");
    const rows = lines.slice(1)
      .map((line) => {
        const cells = line.split("\t");
        while (cells.length < headers.length) cells.push("");
        return cells;
      })
      .filter((row) => row[0] !== "Expansion" && row[0] !== "expansion");

    const headerLine = headers.join("\t");
    const dataLines = rows.map((row) => row.join("\t"));
    return [headerLine, ...dataLines].join("\r\n") + "\r\n";
  }

  private getFileName(uri: vscode.Uri): string {
    if (uri.scheme === "d2mpq") {
      const parts = uri.path.split("/");
      return parts[parts.length - 1];
    }
    return path.basename(uri.fsPath);
  }

  private loadSchema(fileName: string): TxtSchema | null {
    const baseName = fileName.replace(/\.txt$/i, "");

    // Try extension-bundled schemas
    const bundledDir = path.join(
      this.context.extensionUri.fsPath,
      "schemas",
      "txt"
    );

    // Try workspace schemas
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    const workspacePath = path.join(
      workspaceRoot,
      ".d2workshop",
      "schemas",
      "txt",
      `${baseName}.schema.json`
    );

    // Try multiple naming conventions
    const bundledCandidates = [
      path.join(bundledDir, `${baseName}.schema.json`),
      path.join(bundledDir, `${baseName.toLowerCase()}.schema.json`),
      path.join(bundledDir, `${fileName}.schema.json`),
    ];

    for (const schemaPath of [workspacePath, ...bundledCandidates]) {
      try {
        if (fs.existsSync(schemaPath)) {
          console.log(`[D2 Workshop] Loading schema: ${schemaPath}`);
          return JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
        }
      } catch {
        continue;
      }
    }

    console.log(`[D2 Workshop] No schema found for ${fileName}`);
    return null;
  }
}
