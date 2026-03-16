import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SaveQueue, computeTableDiffs } from "../mod/save-queue";
import { getWebviewContent } from "./webview-utils";
import { parseTBL, encodeTBL, tblToTabDelimited, tabDelimitedToTbl } from "../dc6/tbl-parser";
import { parseAnimData, speedToFPS, ANIMATION_EVENT_NAMES } from "../dc6/animdata-parser";

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
  /** Pending row navigation: uri → row number */
  static pendingNavigation = new Map<string, number>();
  /** Active webview panels: uri → webview panel (for sending messages to already-open editors) */
  static activeWebviews = new Map<string, vscode.WebviewPanel>();

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

    // Track active webview for navigation from search results
    const uriKey = document.uri.toString();
    TableEditorProvider.activeWebviews.set(uriKey, webviewPanel);
    webviewPanel.onDidDispose(() => {
      TableEditorProvider.activeWebviews.delete(uriKey);
    });

    // Pre-load the data while webview initializes
    const fileName = this.getFileName(document.uri);
    const schema = this.loadSchema(fileName);
    const isTbl = fileName.toLowerCase().endsWith(".tbl");
    const isAnimData = fileName.toLowerCase() === "animdata.d2";
    let text: string;

    try {
      console.log(
        `[D2 Workshop] Loading table: ${document.uri.toString()}`
      );
      const data = await vscode.workspace.fs.readFile(document.uri);

      if (isAnimData) {
        // Parse AnimData.d2 and convert to tab-delimited
        const animData = parseAnimData(data);
        const lines = ["Name\tFrames/Dir\tSpeed\tFPS\tEvents"];
        for (const [name, records] of animData.records) {
          for (const rec of records) {
            const fps = speedToFPS(rec.speed).toFixed(1);
            const events = Array.from(rec.events.entries())
              .map(([frame, evt]) => `${frame}:${ANIMATION_EVENT_NAMES[evt] || evt}`)
              .join(",") || "";
            lines.push(`${name}\t${rec.framesPerDirection}\t${rec.speed}\t${fps}\t${events}`);
          }
        }
        text = lines.join("\r\n") + "\r\n";
        console.log(`[D2 Workshop] AnimData parsed: ${animData.totalRecords} records for ${fileName}`);
      } else if (isTbl) {
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
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready": {
          // Webview is ready to receive data — send it now
          console.log(`[D2 Workshop] Webview ready, sending ${fileName}`);
          // Resolve ref column values from MPQ before sending
          const enrichedSchema = schema ? await this.resolveRefValues(schema, document.uri) : null;
          webviewPanel.webview.postMessage({
            type: "load",
            content: text,
            fileName,
            schema: enrichedSchema,
          });
          // Check for pending row navigation from search
          const uriKey = document.uri.toString();
          const pendingRow = TableEditorProvider.pendingNavigation.get(uriKey);
          if (pendingRow !== undefined) {
            TableEditorProvider.pendingNavigation.delete(uriKey);
            setTimeout(() => {
              webviewPanel.webview.postMessage({ type: "navigateToRow", row: pendingRow });
            }, 200);
          }
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

  /**
   * Resolve ref column values by reading target files from MPQ.
   * Populates schema.columns[x].values with actual values from the referenced file.
   */
  private async resolveRefValues(schema: TxtSchema, sourceUri: vscode.Uri): Promise<TxtSchema> {
    // Collect unique target files needed
    const targets = new Map<string, { file: string; column: string }>();
    for (const [colName, col] of Object.entries(schema.columns)) {
      if (col.type === "ref" && col.target && col.targetColumn && !col.values?.length) {
        const key = `${col.target}:${col.targetColumn}`;
        if (!targets.has(key)) {
          targets.set(key, { file: col.target, column: col.targetColumn });
        }
      }
    }

    if (targets.size === 0) return schema;

    // Determine which MPQ to read from based on source URI
    const mpqName = sourceUri.scheme === "d2mpq" ? sourceUri.authority : "d2exp.mpq";

    // Read each target file and extract the column values
    const resolvedValues = new Map<string, string[]>();
    for (const [key, { file, column }] of targets) {
      try {
        const targetPath = `data\\global\\excel\\${file}`;
        // Try multiple MPQs: patch_d2 first, then d2exp, then d2data
        let data: Uint8Array | undefined;
        for (const mpq of ["patch_d2.mpq", "d2exp.mpq", "d2data.mpq"]) {
          try {
            const uri = vscode.Uri.parse(`d2mpq://${mpq}/${targetPath.replace(/\\/g, "/")}`);
            data = await vscode.workspace.fs.readFile(uri);
            if (data.length > 0) break;
          } catch { /* try next */ }
        }
        if (!data || data.length === 0) continue;

        const text = new TextDecoder("latin1").decode(data);
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length < 2) continue;

        const headers = lines[0].split("\t");
        const colIdx = headers.findIndex(h => h.toLowerCase() === column.toLowerCase());
        if (colIdx < 0) continue;

        const values = new Set<string>();
        // For small lookup tables (≤5 columns), extract values from ALL columns
        // This handles cases like PlayerClass.txt where both "Player Class" (full name)
        // and "Code" (3-letter) are valid values for the same field across game versions
        const isSmallLookup = headers.length <= 5;
        const colsToExtract = isSmallLookup
          ? headers.map((_, i) => i)
          : [colIdx];

        for (let i = 1; i < lines.length; i++) {
          const cells = lines[i].split("\t");
          for (const ci of colsToExtract) {
            const val = cells[ci]?.trim();
            if (val && val !== "Expansion" && val !== "expansion") {
              values.add(val);
              // Also add lowercase variant for case-insensitive matching
              if (val !== val.toLowerCase()) {
                values.add(val.toLowerCase());
              }
            }
          }
        }
        resolvedValues.set(key, Array.from(values).sort());
      } catch (err) {
        console.log(`[D2 Workshop] Could not resolve ref ${key}: ${err}`);
      }
    }

    if (resolvedValues.size === 0) return schema;

    // Clone schema and inject values
    const enriched: TxtSchema = JSON.parse(JSON.stringify(schema));
    for (const [colName, col] of Object.entries(enriched.columns)) {
      if (col.type === "ref" && col.target && col.targetColumn) {
        const key = `${col.target}:${col.targetColumn}`;
        const vals = resolvedValues.get(key);
        if (vals) {
          col.values = vals;
        }
      }
    }

    console.log(`[D2 Workshop] Resolved ${resolvedValues.size} ref targets with ${Array.from(resolvedValues.values()).reduce((s, v) => s + v.length, 0)} total values`);
    return enriched;
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
