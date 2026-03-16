import * as vscode from "vscode";
import * as path from "path";
import { getWebviewContent } from "./webview-utils";
import { parsePL2, TEXT_COLOR_NAMES } from "../dc6/pl2-parser";

export class PL2ViewerProvider implements vscode.CustomReadonlyEditorProvider {
  private static readonly viewType = "d2workshop.pl2Viewer";

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new PL2ViewerProvider(context);
    return vscode.window.registerCustomEditorProvider(
      PL2ViewerProvider.viewType,
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
      "pl2-viewer"
    );

    const fileName = this.getFileName(document.uri);
    let pl2Data: any = null;
    let error: string | null = null;

    try {
      const rawData = await vscode.workspace.fs.readFile(document.uri);
      const pl2 = parsePL2(rawData);

      pl2Data = {
        basePalette: pl2.basePalette.colors,
        lightLevels: pl2.lightLevelVariations.length,
        invColors: pl2.invColorVariations.length,
        hueVariations: pl2.hueVariations.length,
        textColors: pl2.textColors,
        textColorNames: TEXT_COLOR_NAMES,
        transforms: {
          light: pl2.lightLevelVariations.map(t => Array.from(t.indices)),
          inv: pl2.invColorVariations.map(t => Array.from(t.indices)),
          hue: pl2.hueVariations.map(t => Array.from(t.indices)),
          red: [Array.from(pl2.redTones.indices)],
          green: [Array.from(pl2.greenTones.indices)],
          blue: [Array.from(pl2.blueTones.indices)],
          dark: [Array.from(pl2.darkenedColorShift.indices)],
        },
      };

      console.log(`[D2 Workshop] PL2 parsed: ${pl2.basePalette.colors.length} colors, ${pl2.textColors.length} text colors`);
    } catch (err) {
      console.error(`[D2 Workshop] Failed to load PL2: ${err}`);
      error = String(err);
    }

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "ready") {
        webviewPanel.webview.postMessage({
          type: "load",
          fileName,
          data: pl2Data,
          error,
        });
      }
    });
  }

  private getFileName(uri: vscode.Uri): string {
    if (uri.scheme === "d2mpq") {
      const parts = uri.path.split("/");
      return parts[parts.length - 1];
    }
    return path.basename(uri.fsPath);
  }
}
