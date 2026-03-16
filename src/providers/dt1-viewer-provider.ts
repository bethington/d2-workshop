import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getWebviewContent } from "./webview-utils";
import { parseDT1, decodeTileGfx, cropTileGfx, DT1File, DT1Tile, TILE_ORIENTATIONS } from "../dc6/dt1-parser";
import { applyPalette, detectPalette, parsePalette, findClosestPaletteIndex, Palette } from "../dc6/palette";
import { generateDT1Layout, DT1CompanionLayout } from "../dc6/dt1-composite";
import { generateSpriteSheet, generateTilesetJSON, generateTilesetXML } from "../dc6/tiled-export";
import { PNG } from "pngjs";

interface WebviewTile {
  index: number;
  type: number;
  typeName: string;
  style: number;
  sequence: number;
  direction: number;
  width: number;
  height: number;
  roofHeight: number;
  blockCount: number;
  rgbaBase64: string;
}

export class DT1ViewerProvider implements vscode.CustomReadonlyEditorProvider {
  private static readonly viewType = "d2workshop.dt1Viewer";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string
  ) {}

  static register(
    context: vscode.ExtensionContext,
    workspaceRoot: string
  ): vscode.Disposable {
    const provider = new DT1ViewerProvider(context, workspaceRoot);
    return vscode.window.registerCustomEditorProvider(
      DT1ViewerProvider.viewType,
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
      "dt1-viewer"
    );

    const fileName = this.getFileName(document.uri);
    const internalPath = this.getInternalPath(document.uri);
    const companionPath = this.getCompanionJsonPath(document.uri);

    let webviewTiles: WebviewTile[] = [];
    let companion: DT1CompanionLayout | null = null;
    let error: string | null = null;
    let storedDt1: DT1File | null = null;
    let storedPalette: Palette | null = null;

    try {
      console.log(`[D2 Workshop] Loading DT1: ${document.uri.toString()}`);
      const rawData = await vscode.workspace.fs.readFile(document.uri);
      storedDt1 = parseDT1(rawData);
      console.log(`[D2 Workshop] DT1 parsed: ${storedDt1.tiles.length} tiles`);

      // Load palette
      const paletteName = detectPalette(internalPath);
      storedPalette = await this.loadPalette(paletteName, document.uri);

      // Render tiles to RGBA
      webviewTiles = this.renderTiles(storedDt1, storedPalette);

      // Load or generate companion
      companion = this.loadCompanionJson(companionPath);
      if (!companion) {
        companion = generateDT1Layout(internalPath, paletteName);
        this.saveCompanionJson(companionPath, companion);
      }
    } catch (err) {
      console.error(`[D2 Workshop] Failed to load DT1: ${err}`);
      error = String(err);
    }

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready": {
          webviewPanel.webview.postMessage({
            type: "load",
            fileName,
            tiles: webviewTiles,
            companion,
            error,
          });
          break;
        }
        case "saveCompanion": {
          this.saveCompanionJson(companionPath, message.data);
          companion = message.data;
          break;
        }
        case "changePalette": {
          if (!storedDt1 || !companion) break;
          let newPaletteName = message.palette as string;
          let newPalette: Palette;

          if (newPaletteName === "__custom__") {
            const datUris = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { "Palette files": ["dat"] },
              title: "Select palette .dat file",
            });
            if (!datUris || datUris.length === 0) break;
            const datData = await vscode.workspace.fs.readFile(datUris[0]);
            newPaletteName = datUris[0].fsPath;
            newPalette = parsePalette(datData, newPaletteName);
          } else {
            newPalette = await this.loadPalette(newPaletteName, document.uri);
          }

          storedPalette = newPalette;
          webviewTiles = this.renderTiles(storedDt1, storedPalette);
          companion.palette = newPaletteName;
          this.saveCompanionJson(companionPath, companion);

          webviewPanel.webview.postMessage({
            type: "paletteChanged",
            tiles: webviewTiles,
            companion,
          });
          break;
        }
        case "openInGimp": {
          if (!storedDt1 || !storedPalette || !companion) break;
          const tileIdx = message.tileIndex as number;
          if (tileIdx < 0 || tileIdx >= storedDt1.tiles.length) break;

          const tile = storedDt1.tiles[tileIdx];
          const fullW = Math.abs(tile.width) || 160;
          const fullH = Math.abs(tile.height) || 80;
          const fullPixels = decodeTileGfx(tile.blocks, fullW, fullH);
          const cropped = cropTileGfx(fullPixels, fullW, fullH);
          const rgba = applyPalette(cropped.pixels, storedPalette);

          const tilePng = new PNG({ width: cropped.width, height: cropped.height });
          tilePng.data = Buffer.from(rgba);
          const pngBuffer = PNG.sync.write(tilePng);

          const exportPath = this.getExportPath(document.uri, tileIdx);
          const exportDir = path.dirname(exportPath);
          fs.mkdirSync(exportDir, { recursive: true });
          fs.writeFileSync(exportPath, pngBuffer);

          await this.openInGimp(exportPath);
          break;
        }
        case "importFromGimp": {
          if (!storedDt1 || !storedPalette || !companion) break;
          const importIdx = message.tileIndex as number;
          if (importIdx < 0 || importIdx >= storedDt1.tiles.length) break;

          const importPath = this.getExportPath(document.uri, importIdx);
          if (!fs.existsSync(importPath)) {
            vscode.window.showErrorMessage(`No exported file at ${importPath}. Use "Open in GIMP" first.`);
            break;
          }

          const pngData = fs.readFileSync(importPath);
          const importPng = PNG.sync.read(pngData);

          // Convert RGBA back to palette indices
          const newPixels = new Uint8Array(importPng.width * importPng.height);
          for (let i = 0; i < importPng.width * importPng.height; i++) {
            const off = i * 4;
            const r = importPng.data[off], g = importPng.data[off + 1];
            const b = importPng.data[off + 2], a = importPng.data[off + 3];
            newPixels[i] = a === 0 ? 0 : findClosestPaletteIndex(r, g, b, a, storedPalette);
          }

          // TODO: Re-encode tile blocks from pixel data (requires dt1-encoder)
          // For now, show a message
          vscode.window.showInformationMessage("DT1 tile import will be available after encoder is implemented.");
          break;
        }
        case "exportTileset": {
          if (!storedDt1 || !storedPalette) break;

          const format = await vscode.window.showQuickPick(
            ["JSON (.tsj)", "XML (.tsx)"],
            { placeHolder: "Select tileset format" }
          );
          if (!format) break;

          // Filter tiles if a type filter is active
          const exportTiles = companion && companion.filterType !== "all"
            ? storedDt1.tiles.filter(t => t.type === parseInt(companion!.filterType))
            : storedDt1.tiles;

          const { pngBuffer, tileWidth, tileHeight, columns } = generateSpriteSheet(exportTiles, storedPalette);

          const exportDir = path.join(this.workspaceRoot, ".d2workshop", "tiled");
          fs.mkdirSync(exportDir, { recursive: true });

          const baseName = fileName.replace(/\.dt1$/i, "");
          const pngPath = path.join(exportDir, `${baseName}_tileset.png`);
          fs.writeFileSync(pngPath, pngBuffer);

          const rows = Math.ceil(exportTiles.length / columns);
          const imageWidth = columns * tileWidth;
          const imageHeight = rows * tileHeight;

          if (format.includes("JSON")) {
            const json = generateTilesetJSON(exportTiles, `${baseName}_tileset.png`, tileWidth, tileHeight, columns, imageWidth, imageHeight);
            fs.writeFileSync(path.join(exportDir, `${baseName}.tsj`), json);
          } else {
            const xml = generateTilesetXML(exportTiles, `${baseName}_tileset.png`, tileWidth, tileHeight, columns, imageWidth, imageHeight);
            fs.writeFileSync(path.join(exportDir, `${baseName}.tsx`), xml);
          }

          vscode.window.showInformationMessage(`Tileset exported to ${exportDir}`);
          break;
        }
        case "editCollision": {
          if (!companion) break;
          companion.collisionEdits = message.edits;
          this.saveCompanionJson(companionPath, companion);
          break;
        }
      }
    });
  }

  private renderTiles(dt1: DT1File, palette: Palette): WebviewTile[] {
    const tiles: WebviewTile[] = [];
    for (let i = 0; i < dt1.tiles.length; i++) {
      const tile = dt1.tiles[i];
      const fullW = Math.abs(tile.width) || 160;
      const fullH = Math.abs(tile.height) || 80;
      try {
        const fullPixels = decodeTileGfx(tile.blocks, fullW, fullH);
        const cropped = cropTileGfx(fullPixels, fullW, fullH);
        const rgba = applyPalette(cropped.pixels, palette);
        tiles.push({
          index: i,
          type: tile.type,
          typeName: TILE_ORIENTATIONS[tile.type] || `Type ${tile.type}`,
          style: tile.style,
          sequence: tile.sequence,
          direction: tile.direction,
          width: cropped.width,
          height: cropped.height,
          roofHeight: tile.roofHeight,
          blockCount: tile.blocks.length,
          rgbaBase64: Buffer.from(rgba).toString("base64"),
        });
      } catch {
        // Skip tiles that fail to decode
      }
    }
    return tiles;
  }

  private getFileName(uri: vscode.Uri): string {
    if (uri.scheme === "d2mpq") {
      const parts = uri.path.split("/");
      return parts[parts.length - 1];
    }
    return path.basename(uri.fsPath);
  }

  private getInternalPath(uri: vscode.Uri): string {
    if (uri.scheme === "d2mpq") return uri.path.replace(/^\//, "");
    return path.relative(this.workspaceRoot, uri.fsPath);
  }

  private getCompanionJsonPath(uri: vscode.Uri): string {
    const workshopDir = path.join(this.workspaceRoot, ".d2workshop", "dt1");
    const relativePath = uri.scheme === "d2mpq"
      ? uri.path.replace(/^\//, "").replace(/\//g, path.sep)
      : path.relative(this.workspaceRoot, uri.fsPath);
    return path.join(workshopDir, `${relativePath}.json`);
  }

  private getExportPath(uri: vscode.Uri, tileIndex: number): string {
    const compositesDir = path.join(this.workspaceRoot, ".d2workshop", "composites");
    const relativePath = uri.scheme === "d2mpq"
      ? uri.path.replace(/^\//, "").replace(/\//g, path.sep).replace(/\.dt1$/i, "")
      : path.relative(this.workspaceRoot, uri.fsPath).replace(/\.dt1$/i, "");
    return path.join(compositesDir, `${relativePath}_tile${tileIndex}.png`);
  }

  private loadCompanionJson(jsonPath: string): DT1CompanionLayout | null {
    try {
      if (fs.existsSync(jsonPath)) return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    } catch { /* ignore */ }
    return null;
  }

  private saveCompanionJson(jsonPath: string, data: object): void {
    const dir = path.dirname(jsonPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  }

  private async loadPalette(paletteName: string, dt1Uri: vscode.Uri): Promise<Palette> {
    if (dt1Uri.scheme === "d2mpq") {
      const mpqName = decodeURIComponent(dt1Uri.authority);
      const palPath = `data\\global\\palette\\${paletteName.toUpperCase()}\\pal.dat`;
      const palUri = vscode.Uri.parse(
        `d2mpq://${encodeURIComponent(mpqName)}/${palPath.replace(/\\/g, "/")}`
      );
      try {
        const palData = await vscode.workspace.fs.readFile(palUri);
        return parsePalette(palData, paletteName);
      } catch { /* fall through */ }
      const fallbackUri = vscode.Uri.parse(
        `d2mpq://d2data.mpq/${palPath.replace(/\\/g, "/")}`
      );
      try {
        const palData = await vscode.workspace.fs.readFile(fallbackUri);
        return parsePalette(palData, paletteName);
      } catch { /* fall through */ }
    }
    const defaultPal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      defaultPal[i * 3] = i;
      defaultPal[i * 3 + 1] = i;
      defaultPal[i * 3 + 2] = i;
    }
    return parsePalette(defaultPal, "grayscale");
  }

  private async openInGimp(filePath: string): Promise<void> {
    const gimpPath = vscode.workspace
      .getConfiguration("d2workshop")
      .get<string>("gimpPath") || "gimp";
    try {
      const { exec } = require("child_process");
      exec(`"${gimpPath}" "${filePath}"`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to open GIMP: ${err}`);
    }
  }
}
