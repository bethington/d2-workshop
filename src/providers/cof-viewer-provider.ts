import * as vscode from "vscode";
import * as path from "path";
import { getWebviewContent } from "./webview-utils";
import { parseCOF, COFFile, COMPOSITE_NAMES } from "../dc6/cof-parser";
import { parseDC6 } from "../dc6/dc6-parser";
import { parseDCC, isDCCFile } from "../dc6/dcc-parser";
import { applyPalette, detectPalette, parsePalette, Palette } from "../dc6/palette";
import { MpqManager } from "../mpq/mpq-manager";

interface LayerFrameData {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  rgbaBase64: string;
}

export class COFViewerProvider implements vscode.CustomReadonlyEditorProvider {
  private static readonly viewType = "d2workshop.cofViewer";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mpqManager: MpqManager
  ) {}

  static register(
    context: vscode.ExtensionContext,
    mpqManager: MpqManager
  ): vscode.Disposable {
    const provider = new COFViewerProvider(context, mpqManager);
    return vscode.window.registerCustomEditorProvider(
      COFViewerProvider.viewType,
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
      "cof-viewer"
    );

    const fileName = this.getFileName(document.uri);
    let cofData: any = null;
    let error: string | null = null;

    try {
      const rawData = await vscode.workspace.fs.readFile(document.uri);
      const cof = parseCOF(rawData);

      // Resolve the COF context (token, animation mode, weapon class)
      const cofPath = this.getInternalPath(document.uri);
      const context = this.resolveCOFContext(cofPath, cof);

      // Load palette
      const paletteName = detectPalette(cofPath);
      const palette = await this.loadPalette(paletteName, document.uri);

      // Load layer sprites
      const layers = await this.loadLayers(cof, context, document.uri, palette);

      cofData = {
        cof: {
          numberOfLayers: cof.numberOfLayers,
          framesPerDirection: cof.framesPerDirection,
          numberOfDirections: cof.numberOfDirections,
          speed: cof.speed,
          layers: cof.layers.map(l => ({
            type: l.type,
            typeName: COMPOSITE_NAMES[l.type] || `Type ${l.type}`,
            shadow: l.shadow,
            selectable: l.selectable,
            transparent: l.transparent,
            drawEffect: l.drawEffect,
            weaponClass: l.weaponClass,
          })),
        },
        layers,
        context,
      };
    } catch (err) {
      console.error(`[D2 Workshop] Failed to load COF: ${err}`);
      error = String(err);
    }

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "ready") {
        webviewPanel.webview.postMessage({
          type: "load",
          fileName,
          data: cofData,
          error,
        });
      }
    });
  }

  private resolveCOFContext(cofPath: string, cof: COFFile): {
    token: string;
    animMode: string;
    weaponClass: string;
    basePath: string;
  } {
    // COF path pattern: {basePath}/{token}/COF/{token}{animMode}{weaponClass}.COF
    const normalized = cofPath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const cofFileName = parts[parts.length - 1].replace(/\.cof$/i, "");

    // Find the token (parent of COF directory)
    const cofDirIdx = parts.findIndex(p => p.toUpperCase() === "COF");
    const token = cofDirIdx > 0 ? parts[cofDirIdx - 1] : "";
    const basePath = cofDirIdx > 1 ? parts.slice(0, cofDirIdx - 1).join("/") : "";

    // Extract animation mode and weapon class from filename
    // Filename: {token}{animMode}{weaponClass}
    // token is typically 2 chars, animMode is 2 chars, weaponClass is 3 chars
    let animMode = "";
    let weaponClass = "";
    if (cofFileName.length > token.length) {
      const remainder = cofFileName.substring(token.length);
      animMode = remainder.substring(0, 2);
      weaponClass = remainder.substring(2);
    }

    return { token, animMode, weaponClass, basePath };
  }

  private async loadLayers(
    cof: COFFile,
    context: { token: string; animMode: string; weaponClass: string; basePath: string },
    cofUri: vscode.Uri,
    palette: Palette
  ): Promise<Array<{
    type: number;
    typeName: string;
    found: boolean;
    path: string;
    frames: LayerFrameData[][];
  }>> {
    const layers = [];

    // Composite type abbreviations
    const LAYER_KEYS: Record<number, string> = {
      0: "HD", 1: "TR", 2: "LG", 3: "RA", 4: "LA",
      5: "RH", 6: "LH", 7: "SH", 8: "S1", 9: "S2",
      10: "S3", 11: "S4", 12: "S5", 13: "S6", 14: "S7", 15: "S8",
    };

    for (const layer of cof.layers) {
      const layerKey = LAYER_KEYS[layer.type] || `S${layer.type}`;
      const layerResult: {
        type: number;
        typeName: string;
        found: boolean;
        path: string;
        frames: LayerFrameData[][];
      } = {
        type: layer.type,
        typeName: COMPOSITE_NAMES[layer.type] || `Type ${layer.type}`,
        found: false,
        path: "",
        frames: [],
      };

      // Try to find the DCC/DC6 file for this layer
      // Pattern: {basePath}/{token}/{layerKey}/{token}{layerKey}{layerValue}{animMode}{weaponClass}.dcc
      // layerValue is typically "LIT" for the base appearance
      const layerValues = ["LIT", "MED", "HVY"];

      for (const layerValue of layerValues) {
        const dccPath = `${context.basePath}/${context.token}/${layerKey}/${context.token}${layerKey}${layerValue}${context.animMode}${context.weaponClass}.dcc`;
        const dc6Path = `${context.basePath}/${context.token}/${layerKey}/${context.token}${layerKey}${layerValue}${context.animMode}${context.weaponClass}.dc6`;

        for (const tryPath of [dccPath, dc6Path]) {
          try {
            if (cofUri.scheme === "d2mpq") {
              const mpqName = decodeURIComponent(cofUri.authority);
              if (this.mpqManager.hasFile(mpqName, tryPath)) {
                const fileData = this.mpqManager.readFile(mpqName, tryPath);
                const isDcc = isDCCFile(fileData);
                const parsed = isDcc ? parseDCC(fileData) : parseDC6(fileData);

                // Convert frames to RGBA grouped by direction
                const dirFrames: LayerFrameData[][] = [];
                for (let d = 0; d < parsed.header.directions; d++) {
                  const frames: LayerFrameData[] = [];
                  for (let f = 0; f < parsed.header.framesPerDirection; f++) {
                    const frameIdx = d * parsed.header.framesPerDirection + f;
                    if (frameIdx < parsed.frames.length) {
                      const frame = parsed.frames[frameIdx];
                      const rgba = applyPalette(frame.pixels, palette);
                      frames.push({
                        width: frame.width,
                        height: frame.height,
                        offsetX: frame.offsetX,
                        offsetY: frame.offsetY,
                        rgbaBase64: Buffer.from(rgba).toString("base64"),
                      });
                    }
                  }
                  dirFrames.push(frames);
                }

                layerResult.found = true;
                layerResult.path = tryPath;
                layerResult.frames = dirFrames;
                break;
              }
            }
          } catch {
            // Continue trying other paths
          }
        }
        if (layerResult.found) break;
      }

      layers.push(layerResult);
    }

    return layers;
  }

  private getFileName(uri: vscode.Uri): string {
    if (uri.scheme === "d2mpq") {
      const parts = uri.path.split("/");
      return parts[parts.length - 1];
    }
    return path.basename(uri.fsPath);
  }

  private getInternalPath(uri: vscode.Uri): string {
    if (uri.scheme === "d2mpq") {
      return uri.path.replace(/^\//, "");
    }
    return "";
  }

  private async loadPalette(
    paletteName: string,
    cofUri: vscode.Uri
  ): Promise<Palette> {
    if (cofUri.scheme === "d2mpq") {
      const mpqName = decodeURIComponent(cofUri.authority);
      const palPath = `data/global/palette/${paletteName.toUpperCase()}/pal.dat`;
      try {
        if (this.mpqManager.hasFile(mpqName, palPath)) {
          const palData = this.mpqManager.readFile(mpqName, palPath);
          return parsePalette(palData, paletteName);
        }
      } catch { /* fall through */ }

      // Try d2data.mpq fallback
      try {
        if (this.mpqManager.hasFile("d2data.mpq", palPath)) {
          const palData = this.mpqManager.readFile("d2data.mpq", palPath);
          return parsePalette(palData, paletteName);
        }
      } catch { /* fall through */ }
    }

    // Grayscale fallback
    const defaultPal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      defaultPal[i * 3] = i;
      defaultPal[i * 3 + 1] = i;
      defaultPal[i * 3 + 2] = i;
    }
    return parsePalette(defaultPal, "grayscale");
  }
}
