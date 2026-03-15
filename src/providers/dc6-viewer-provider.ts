import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getWebviewContent } from "./webview-utils";
import { parseDC6, DC6File, DC6Frame } from "../dc6/dc6-parser";
import { parseDCC, isDCCFile } from "../dc6/dcc-parser";
import { encodeDC6 } from "../dc6/dc6-encoder";
import { parsePalette, applyPalette, detectPalette, findClosestPaletteIndex, Palette } from "../dc6/palette";
import { PNG } from "pngjs";
import { generateGridLayout, fitCanvasToFrames, renderComposite, sliceComposite, DC6CompanionLayout } from "../dc6/composite";
import { createOpenRaster, readOpenRaster } from "../dc6/openraster";

/** Frame data sent to the webview for rendering. */
interface WebviewFrame {
  width: number;
  height: number;
  direction: number;
  frameIndex: number;
  offsetX: number;
  offsetY: number;
  /** RGBA pixel data as base64 */
  rgbaBase64: string;
}

export class DC6ViewerProvider implements vscode.CustomReadonlyEditorProvider {
  private static readonly viewType = "d2workshop.dc6Viewer";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string
  ) {}

  static register(
    context: vscode.ExtensionContext,
    workspaceRoot: string
  ): vscode.Disposable {
    const provider = new DC6ViewerProvider(context, workspaceRoot);
    return vscode.window.registerCustomEditorProvider(
      DC6ViewerProvider.viewType,
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
      "dc6-viewer"
    );

    const fileName = this.getFileName(document.uri);
    const internalPath = this.getInternalPath(document.uri);
    const companionPath = this.getCompanionJsonPath(document.uri);

    // Pre-load DC6 data
    let webviewFrames: WebviewFrame[] = [];
    let companion: DC6CompanionLayout | null = null;
    let error: string | null = null;
    let storedDc6: DC6File | null = null;
    let storedPalette: Palette | null = null;
    let gimpFileWatcher: vscode.FileSystemWatcher | null = null;

    // Clean up file watcher when panel is disposed
    webviewPanel.onDidDispose(() => {
      gimpFileWatcher?.dispose();
      gimpFileWatcher = null;
    });

    try {
      console.log(`[D2 Workshop] Loading sprite: ${document.uri.toString()}`);

      // Read binary data
      const dc6Data = await vscode.workspace.fs.readFile(document.uri);
      console.log(`[D2 Workshop] Sprite binary: ${dc6Data.length} bytes`);

      // Parse as DCC or DC6
      const isDcc = isDCCFile(dc6Data);
      storedDc6 = isDcc ? parseDCC(dc6Data) : parseDC6(dc6Data);
      console.log(
        `[D2 Workshop] ${isDcc ? "DCC" : "DC6"} parsed: ${storedDc6.header.directions} dirs, ` +
          `${storedDc6.header.framesPerDirection} frames/dir, ` +
          `${storedDc6.frames.length} total frames`
      );

      // Load palette
      const paletteName = detectPalette(internalPath);
      storedPalette = await this.loadPalette(paletteName, document.uri);

      // Convert frames to RGBA for webview
      webviewFrames = storedDc6.frames.map((frame) => {
        const rgba = applyPalette(frame.pixels, storedPalette!);
        return {
          width: frame.width,
          height: frame.height,
          direction: frame.direction,
          frameIndex: frame.frameIndex,
          offsetX: frame.offsetX,
          offsetY: frame.offsetY,
          rgbaBase64: Buffer.from(rgba).toString("base64"),
        };
      });

      // Load or generate companion layout
      companion = this.loadCompanionJson(companionPath);
      if (!companion) {
        companion = generateGridLayout(storedDc6.frames, internalPath, paletteName);
        console.log(`[D2 Workshop] Generated companion JSON: ${companionPath}`);

        // Auto-detect animation: all frames same size, 5+ frames, max 128x128
        if (storedDc6.frames.length > 4) {
          const firstW = storedDc6.frames[0].width;
          const firstH = storedDc6.frames[0].height;
          const allSameSize = storedDc6.frames.every(
            (f) => f.width === firstW && f.height === firstH
          );
          if (allSameSize && firstW <= 128 && firstH <= 128) {
            companion.displayMode = "animation";
            companion.canvasWidth = firstW;
            companion.canvasHeight = firstH;
            console.log(`[D2 Workshop] Auto-detected animation mode: ${firstW}x${firstH}`);
          }
        }
      }
      // Recalculate canvas size based on display mode
      if (companion.displayMode === "animation" || companion.displayMode === "button") {
        // Animation/button: canvas = max frame dimensions
        let maxW = 0, maxH = 0;
        for (const f of storedDc6.frames) {
          maxW = Math.max(maxW, f.width);
          maxH = Math.max(maxH, f.height);
        }
        companion.canvasWidth = maxW || 1;
        companion.canvasHeight = maxH || 1;
      } else {
        // Composite: tightly fit all frame layout positions
        const fit = fitCanvasToFrames(companion.frames);
        companion.canvasWidth = fit.canvasWidth;
        companion.canvasHeight = fit.canvasHeight;
      }
      this.saveCompanionJson(companionPath, companion);
    } catch (err) {
      console.error(`[D2 Workshop] Failed to load DC6: ${err}`);
      error = String(err);
    }

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready": {
          console.log(`[D2 Workshop] DC6 webview ready, sending ${fileName}`);
          webviewPanel.webview.postMessage({
            type: "load",
            fileName,
            frames: webviewFrames,
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
        case "relayout": {
          if (!storedDc6 || !companion) break;
          const palName = companion.palette;
          const relayoutCompanion = generateGridLayout(storedDc6.frames, internalPath, palName);
          // Preserve non-layout fields
          relayoutCompanion.displayMode = companion.displayMode;
          relayoutCompanion.animationSpeed = companion.animationSpeed;
          relayoutCompanion.palette = companion.palette;
          companion = relayoutCompanion;
          this.saveCompanionJson(companionPath, companion);
          webviewPanel.webview.postMessage({
            type: "framesReloaded",
            frames: webviewFrames,
            companion,
          });
          break;
        }
        case "changePalette": {
          if (!storedDc6 || !companion) break;
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

          // Re-render all frames with new palette
          webviewFrames = storedDc6.frames.map((frame) => {
            const rgba = applyPalette(frame.pixels, storedPalette!);
            return {
              width: frame.width,
              height: frame.height,
              direction: frame.direction,
              frameIndex: frame.frameIndex,
              offsetX: frame.offsetX,
              offsetY: frame.offsetY,
              rgbaBase64: Buffer.from(rgba).toString("base64"),
            };
          });

          // Update companion with new palette name
          companion.palette = newPaletteName;
          this.saveCompanionJson(companionPath, companion);

          webviewPanel.webview.postMessage({
            type: "paletteChanged",
            frames: webviewFrames,
            companion,
          });
          break;
        }
        case "openInGimp": {
          if (!storedDc6 || !storedPalette || !companion) break;

          let exportedFilePath: string;
          if (companion.displayMode === "animation" || companion.displayMode === "button") {
            // Export as OpenRaster (.ora) with layers
            exportedFilePath = this.getCompositePngPath(document.uri).replace(/\.png$/i, ".ora");
            const oraBuffer = await createOpenRaster(storedDc6.frames, storedPalette);
            const oraDir = path.dirname(exportedFilePath);
            fs.mkdirSync(oraDir, { recursive: true });
            fs.writeFileSync(exportedFilePath, oraBuffer);
          } else {
            // Composite: export as PNG using layout positions
            exportedFilePath = this.getCompositePngPath(document.uri);
            const compositeRgba = renderComposite(storedDc6.frames, companion, storedPalette);
            const exportPng = new PNG({ width: companion.canvasWidth, height: companion.canvasHeight });
            exportPng.data = Buffer.from(compositeRgba);
            const pngBuffer = PNG.sync.write(exportPng);
            const compositeDir = path.dirname(exportedFilePath);
            fs.mkdirSync(compositeDir, { recursive: true });
            fs.writeFileSync(exportedFilePath, pngBuffer);
          }

          // Set up file watcher for auto-detect if enabled
          const autoDetect = vscode.workspace
            .getConfiguration("d2workshop")
            .get<boolean>("autoDetectGimpChanges");
          if (autoDetect && !gimpFileWatcher) {
            const watchPattern = new vscode.RelativePattern(
              path.dirname(exportedFilePath),
              path.basename(exportedFilePath)
            );
            gimpFileWatcher = vscode.workspace.createFileSystemWatcher(watchPattern);
            gimpFileWatcher.onDidChange(() => {
              // Trigger import by simulating the importFromGimp message
              webviewPanel.webview.postMessage({ type: "__gimpFileChanged" });
            });
          }

          await this.openInGimp(exportedFilePath);
          break;
        }
        case "importFromGimp": {
          if (!storedDc6 || !storedPalette || !companion) break;

          if (companion.displayMode === "animation" || companion.displayMode === "button") {
            // Import from .ora (OpenRaster with layers)
            const oraPath = this.getCompositePngPath(document.uri).replace(/\.png$/i, ".ora");
            if (!fs.existsSync(oraPath)) {
              vscode.window.showErrorMessage(`No exported file found at ${oraPath}. Use "Open in GIMP" first.`);
              break;
            }
            const oraBuffer = fs.readFileSync(oraPath);
            const layers = await readOpenRaster(Buffer.from(oraBuffer));

            // Update each frame from layer data
            for (let i = 0; i < Math.min(layers.length, storedDc6.frames.length); i++) {
              const layer = layers[i];
              const frame = storedDc6.frames[i];

              // Convert RGBA to palette indices
              const pixels = new Uint8Array(layer.width * layer.height);
              for (let p = 0; p < layer.width * layer.height; p++) {
                const off = p * 4;
                const r = layer.rgba[off], g = layer.rgba[off + 1], b = layer.rgba[off + 2], a = layer.rgba[off + 3];
                pixels[p] = a === 0 ? 0 : findClosestPaletteIndex(r, g, b, a, storedPalette);
              }

              frame.pixels = pixels;
              frame.width = layer.width;
              frame.height = layer.height;
            }
          } else {
            // Import from composite PNG
            const compositePath = this.getCompositePngPath(document.uri);
            if (!fs.existsSync(compositePath)) {
              vscode.window.showErrorMessage(`No exported file found at ${compositePath}. Use "Open in GIMP" first.`);
              break;
            }
            const pngData = fs.readFileSync(compositePath);
            const compositePng = PNG.sync.read(pngData);
            const compositeRgba = new Uint8Array(compositePng.data);

            // Slice composite back into frames using layout positions
            const slicedPixels = sliceComposite(compositeRgba, compositePng.width, companion, storedPalette);

            for (let i = 0; i < Math.min(slicedPixels.length, storedDc6.frames.length); i++) {
              storedDc6.frames[i].pixels = slicedPixels[i];
            }
          }

          // Re-encode and write DC6
          storedDc6.header.directions = 1;
          storedDc6.header.framesPerDirection = storedDc6.frames.length;
          const importEncoded = encodeDC6(storedDc6.header, storedDc6.frames);
          await vscode.workspace.fs.writeFile(document.uri, importEncoded);

          // Rebuild webview frames
          webviewFrames = storedDc6.frames.map((frame) => {
            const rgba = applyPalette(frame.pixels, storedPalette!);
            return {
              width: frame.width,
              height: frame.height,
              direction: frame.direction,
              frameIndex: frame.frameIndex,
              offsetX: frame.offsetX,
              offsetY: frame.offsetY,
              rgbaBase64: Buffer.from(rgba).toString("base64"),
            };
          });

          // Update companion frame dimensions
          for (let i = 0; i < Math.min(companion.frames.length, storedDc6.frames.length); i++) {
            companion.frames[i].width = storedDc6.frames[i].width;
            companion.frames[i].height = storedDc6.frames[i].height;
          }
          const importFit = fitCanvasToFrames(companion.frames);
          companion.canvasWidth = Math.max(1, importFit.canvasWidth);
          companion.canvasHeight = Math.max(1, importFit.canvasHeight);
          this.saveCompanionJson(companionPath, companion);

          webviewPanel.webview.postMessage({
            type: "framesReloaded",
            frames: webviewFrames,
            companion,
          });

          vscode.window.showInformationMessage("Imported changes from GIMP successfully.");
          break;
        }
        case "resizeFrame": {
          if (!storedDc6 || !storedPalette || !companion) break;
          const idx = message.frameIndex as number;
          const newW = message.newWidth as number;
          const newH = message.newHeight as number;
          if (idx < 0 || idx >= storedDc6.frames.length) break;

          const frame = storedDc6.frames[idx];
          const newPixels = new Uint8Array(newW * newH); // 0 = transparent
          for (let y = 0; y < Math.min(frame.height, newH); y++) {
            for (let x = 0; x < Math.min(frame.width, newW); x++) {
              newPixels[y * newW + x] = frame.pixels[y * frame.width + x];
            }
          }
          frame.pixels = newPixels;
          frame.width = newW;
          frame.height = newH;

          // Re-encode and write DC6
          const encoded = encodeDC6(storedDc6.header, storedDc6.frames);
          await vscode.workspace.fs.writeFile(document.uri, encoded);

          // Update webview frame
          const rgba = applyPalette(frame.pixels, storedPalette);
          const updatedWebviewFrame: WebviewFrame = {
            width: newW,
            height: newH,
            direction: frame.direction,
            frameIndex: frame.frameIndex,
            offsetX: frame.offsetX,
            offsetY: frame.offsetY,
            rgbaBase64: Buffer.from(rgba).toString("base64"),
          };
          webviewFrames[idx] = updatedWebviewFrame;

          // Update companion layout frame dimensions
          companion.frames[idx] = {
            ...companion.frames[idx],
            width: newW,
            height: newH,
          };
          const resizeFit = fitCanvasToFrames(companion.frames);
          companion.canvasWidth = resizeFit.canvasWidth;
          companion.canvasHeight = resizeFit.canvasHeight;
          this.saveCompanionJson(companionPath, companion);

          webviewPanel.webview.postMessage({
            type: "frameUpdated",
            frameIndex: idx,
            frame: updatedWebviewFrame,
            companion,
          });
          break;
        }
        case "deleteFramePrompt": {
          if (!storedDc6 || !storedPalette || !companion) break;
          const promptIdx = message.frameIndex as number;
          if (promptIdx < 0 || promptIdx >= storedDc6.frames.length) break;

          const confirmDel = await vscode.window.showWarningMessage(
            `Delete frame ${promptIdx}? This will modify the DC6 file.`,
            { modal: true },
            "Delete"
          );
          if (confirmDel !== "Delete") break;

          storedDc6.frames.splice(promptIdx, 1);
          storedDc6.header.directions = 1;
          storedDc6.header.framesPerDirection = storedDc6.frames.length;

          const delEncoded2 = encodeDC6(storedDc6.header, storedDc6.frames);
          await vscode.workspace.fs.writeFile(document.uri, delEncoded2);

          webviewFrames.splice(promptIdx, 1);
          companion.frames.splice(promptIdx, 1);
          const delFit2 = fitCanvasToFrames(companion.frames);
          companion.canvasWidth = Math.max(1, delFit2.canvasWidth);
          companion.canvasHeight = Math.max(1, delFit2.canvasHeight);
          this.saveCompanionJson(companionPath, companion);

          webviewPanel.webview.postMessage({
            type: "framesReloaded",
            frames: webviewFrames,
            companion,
          });
          break;
        }
        case "insertFramePrompt": {
          if (!storedDc6 || !storedPalette || !companion) break;

          const insertChoice = await vscode.window.showQuickPick(
            ["Import PNG", "Blank Frame"],
            { placeHolder: "Add a new frame" }
          );
          if (!insertChoice) break;

          // Determine insertion index
          let promptInsertIdx: number;
          const promptPos = message.position as string;
          if (promptPos === "end") {
            promptInsertIdx = storedDc6.frames.length;
          } else if (promptPos === "before") {
            promptInsertIdx = message.relativeToIndex as number;
          } else {
            promptInsertIdx = (message.relativeToIndex as number) + 1;
          }

          if (insertChoice === "Import PNG") {
            const pngUris2 = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { "PNG Images": ["png"] },
              title: "Import PNG as frame",
            });
            if (!pngUris2 || pngUris2.length === 0) break;

            const pngData2 = await vscode.workspace.fs.readFile(pngUris2[0]);
            const png2 = PNG.sync.read(Buffer.from(pngData2));

            const pixels2 = new Uint8Array(png2.width * png2.height);
            for (let i = 0; i < png2.width * png2.height; i++) {
              const off = i * 4;
              pixels2[i] = png2.data[off + 3] === 0
                ? 0
                : findClosestPaletteIndex(png2.data[off], png2.data[off + 1], png2.data[off + 2], png2.data[off + 3], storedPalette);
            }

            const newFrame2: DC6Frame = {
              flip: 0, width: png2.width, height: png2.height,
              offsetX: 0, offsetY: 0, length: 0, direction: 0, frameIndex: 0, pixels: pixels2,
            };
            storedDc6.frames.splice(promptInsertIdx, 0, newFrame2);
            storedDc6.header.directions = 1;
            storedDc6.header.framesPerDirection = storedDc6.frames.length;

            const enc2 = encodeDC6(storedDc6.header, storedDc6.frames);
            await vscode.workspace.fs.writeFile(document.uri, enc2);

            const rgba2 = applyPalette(pixels2, storedPalette);
            webviewFrames.splice(promptInsertIdx, 0, {
              width: png2.width, height: png2.height, direction: 0, frameIndex: 0,
              offsetX: 0, offsetY: 0, rgbaBase64: Buffer.from(rgba2).toString("base64"),
            });

            const fit2a = fitCanvasToFrames(companion.frames);
            companion.frames.splice(promptInsertIdx, 0, {
              canvasX: fit2a.canvasWidth, canvasY: 0,
              width: png2.width, height: png2.height,
              direction: 0, frameIndex: 0, offsetX: 0, offsetY: 0,
            });
          } else {
            // Blank Frame
            let mfw = 0, mfh = 0;
            for (const f of storedDc6.frames) { mfw = Math.max(mfw, f.width); mfh = Math.max(mfh, f.height); }
            const bw = mfw > 0 ? mfw : 32;
            const bh = mfh > 0 ? mfh : 32;
            const bp = new Uint8Array(bw * bh);

            const blankFrame2: DC6Frame = {
              flip: 0, width: bw, height: bh,
              offsetX: 0, offsetY: 0, length: 0, direction: 0, frameIndex: 0, pixels: bp,
            };
            storedDc6.frames.splice(promptInsertIdx, 0, blankFrame2);
            storedDc6.header.directions = 1;
            storedDc6.header.framesPerDirection = storedDc6.frames.length;

            const enc3 = encodeDC6(storedDc6.header, storedDc6.frames);
            await vscode.workspace.fs.writeFile(document.uri, enc3);

            const rgba3 = applyPalette(bp, storedPalette);
            webviewFrames.splice(promptInsertIdx, 0, {
              width: bw, height: bh, direction: 0, frameIndex: 0,
              offsetX: 0, offsetY: 0, rgbaBase64: Buffer.from(rgba3).toString("base64"),
            });

            const fit3a = fitCanvasToFrames(companion.frames);
            companion.frames.splice(promptInsertIdx, 0, {
              canvasX: fit3a.canvasWidth, canvasY: 0,
              width: bw, height: bh,
              direction: 0, frameIndex: 0, offsetX: 0, offsetY: 0,
            });
          }

          const fitFinal = fitCanvasToFrames(companion.frames);
          companion.canvasWidth = Math.max(1, fitFinal.canvasWidth);
          companion.canvasHeight = Math.max(1, fitFinal.canvasHeight);
          this.saveCompanionJson(companionPath, companion);

          webviewPanel.webview.postMessage({
            type: "framesReloaded",
            frames: webviewFrames,
            companion,
          });
          break;
        }
        case "importFrame": {
          if (!storedDc6 || !storedPalette || !companion) break;

          const pngUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { "PNG Images": ["png"] },
            title: "Import PNG as frame",
          });
          if (!pngUris || pngUris.length === 0) break;

          const pngData = await vscode.workspace.fs.readFile(pngUris[0]);
          const png = PNG.sync.read(Buffer.from(pngData));

          // Convert RGBA pixels to palette indices
          const pixels = new Uint8Array(png.width * png.height);
          for (let i = 0; i < png.width * png.height; i++) {
            const off = i * 4;
            const r = png.data[off];
            const g = png.data[off + 1];
            const b = png.data[off + 2];
            const a = png.data[off + 3];
            pixels[i] = a === 0 ? 0 : findClosestPaletteIndex(r, g, b, a, storedPalette);
          }

          const newDc6Frame: DC6Frame = {
            flip: 0,
            width: png.width,
            height: png.height,
            offsetX: 0,
            offsetY: 0,
            length: 0,
            direction: 0,
            frameIndex: 0,
            pixels,
          };

          // Determine insertion index
          let insertIdx: number;
          const pos = message.position as string;
          if (pos === "end") {
            insertIdx = storedDc6.frames.length;
          } else if (pos === "before") {
            insertIdx = message.relativeToIndex as number;
          } else {
            insertIdx = (message.relativeToIndex as number) + 1;
          }

          storedDc6.frames.splice(insertIdx, 0, newDc6Frame);
          storedDc6.header.directions = 1;
          storedDc6.header.framesPerDirection = storedDc6.frames.length;

          const importEncoded = encodeDC6(storedDc6.header, storedDc6.frames);
          await vscode.workspace.fs.writeFile(document.uri, importEncoded);

          // Build webview frame
          const importRgba = applyPalette(pixels, storedPalette);
          const importWebviewFrame: WebviewFrame = {
            width: png.width,
            height: png.height,
            direction: 0,
            frameIndex: 0,
            offsetX: 0,
            offsetY: 0,
            rgbaBase64: Buffer.from(importRgba).toString("base64"),
          };
          webviewFrames.splice(insertIdx, 0, importWebviewFrame);

          // Add to companion layout — place at end of canvas
          const importFit = fitCanvasToFrames(companion.frames);
          companion.frames.splice(insertIdx, 0, {
            canvasX: importFit.canvasWidth,
            canvasY: 0,
            width: png.width,
            height: png.height,
            direction: 0,
            frameIndex: 0,
            offsetX: 0,
            offsetY: 0,
          });
          const importFit2 = fitCanvasToFrames(companion.frames);
          companion.canvasWidth = Math.max(1, importFit2.canvasWidth);
          companion.canvasHeight = Math.max(1, importFit2.canvasHeight);
          this.saveCompanionJson(companionPath, companion);

          webviewPanel.webview.postMessage({
            type: "framesReloaded",
            frames: webviewFrames,
            companion,
          });
          break;
        }
        case "insertBlankFrame": {
          if (!storedDc6 || !storedPalette || !companion) break;

          // Use max frame dimensions or 32x32 default
          let maxFrameW = 0, maxFrameH = 0;
          for (const f of storedDc6.frames) {
            maxFrameW = Math.max(maxFrameW, f.width);
            maxFrameH = Math.max(maxFrameH, f.height);
          }
          const blankW = maxFrameW > 0 ? maxFrameW : 32;
          const blankH = maxFrameH > 0 ? maxFrameH : 32;
          const blankPixels = new Uint8Array(blankW * blankH); // all 0 = transparent

          const blankDc6Frame: DC6Frame = {
            flip: 0,
            width: blankW,
            height: blankH,
            offsetX: 0,
            offsetY: 0,
            length: 0,
            direction: 0,
            frameIndex: 0,
            pixels: blankPixels,
          };

          let blankInsertIdx: number;
          const blankPos = message.position as string;
          if (blankPos === "end") {
            blankInsertIdx = storedDc6.frames.length;
          } else if (blankPos === "before") {
            blankInsertIdx = message.relativeToIndex as number;
          } else {
            blankInsertIdx = (message.relativeToIndex as number) + 1;
          }

          storedDc6.frames.splice(blankInsertIdx, 0, blankDc6Frame);
          storedDc6.header.directions = 1;
          storedDc6.header.framesPerDirection = storedDc6.frames.length;

          const blankEncoded = encodeDC6(storedDc6.header, storedDc6.frames);
          await vscode.workspace.fs.writeFile(document.uri, blankEncoded);

          const blankRgba = applyPalette(blankPixels, storedPalette);
          const blankWebviewFrame: WebviewFrame = {
            width: blankW,
            height: blankH,
            direction: 0,
            frameIndex: 0,
            offsetX: 0,
            offsetY: 0,
            rgbaBase64: Buffer.from(blankRgba).toString("base64"),
          };
          webviewFrames.splice(blankInsertIdx, 0, blankWebviewFrame);

          const blankFit = fitCanvasToFrames(companion.frames);
          companion.frames.splice(blankInsertIdx, 0, {
            canvasX: blankFit.canvasWidth,
            canvasY: 0,
            width: blankW,
            height: blankH,
            direction: 0,
            frameIndex: 0,
            offsetX: 0,
            offsetY: 0,
          });
          const blankFit2 = fitCanvasToFrames(companion.frames);
          companion.canvasWidth = Math.max(1, blankFit2.canvasWidth);
          companion.canvasHeight = Math.max(1, blankFit2.canvasHeight);
          this.saveCompanionJson(companionPath, companion);

          webviewPanel.webview.postMessage({
            type: "framesReloaded",
            frames: webviewFrames,
            companion,
          });
          break;
        }
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

  private getInternalPath(uri: vscode.Uri): string {
    if (uri.scheme === "d2mpq") {
      return uri.path.replace(/^\//, "");
    }
    return path.relative(this.workspaceRoot, uri.fsPath);
  }

  private async loadPalette(
    paletteName: string,
    dc6Uri: vscode.Uri
  ): Promise<ReturnType<typeof parsePalette>> {
    // Try to load from MPQ
    if (dc6Uri.scheme === "d2mpq") {
      const mpqName = decodeURIComponent(dc6Uri.authority);
      const palPath = `data\\global\\palette\\${paletteName.toUpperCase()}\\pal.dat`;
      const palUri = vscode.Uri.parse(
        `d2mpq://${encodeURIComponent(mpqName)}/${palPath.replace(/\\/g, "/")}`
      );

      try {
        const palData = await vscode.workspace.fs.readFile(palUri);
        return parsePalette(palData, paletteName);
      } catch {
        console.warn(
          `[D2 Workshop] Palette ${paletteName} not found in ${mpqName}, trying d2data.mpq`
        );
      }

      // Try d2data.mpq as fallback
      const fallbackUri = vscode.Uri.parse(
        `d2mpq://d2data.mpq/${palPath.replace(/\\/g, "/")}`
      );
      try {
        const palData = await vscode.workspace.fs.readFile(fallbackUri);
        return parsePalette(palData, paletteName);
      } catch {
        console.warn(
          `[D2 Workshop] Palette ${paletteName} not found in d2data.mpq either`
        );
      }
    }

    // Return a default grayscale palette
    console.warn(`[D2 Workshop] Using default grayscale palette`);
    const defaultPal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      defaultPal[i * 3] = i; // R (stored as B in D2)
      defaultPal[i * 3 + 1] = i; // G
      defaultPal[i * 3 + 2] = i; // B (stored as R in D2)
    }
    return parsePalette(defaultPal, "grayscale");
  }

  private getCompanionJsonPath(uri: vscode.Uri): string {
    const workshopDir = path.join(this.workspaceRoot, ".d2workshop", "dc6");
    const relativePath =
      uri.scheme === "d2mpq"
        ? uri.path.replace(/^\//, "").replace(/\//g, path.sep)
        : path.relative(this.workspaceRoot, uri.fsPath);
    return path.join(workshopDir, `${relativePath}.json`);
  }

  private getCompositePngPath(uri: vscode.Uri): string {
    const compositesDir = path.join(
      this.workspaceRoot,
      ".d2workshop",
      "composites"
    );
    const relativePath =
      uri.scheme === "d2mpq"
        ? uri.path
            .replace(/^\//, "")
            .replace(/\//g, path.sep)
            .replace(/\.dc6$/i, ".png")
        : path
            .relative(this.workspaceRoot, uri.fsPath)
            .replace(/\.dc6$/i, ".png");
    return path.join(compositesDir, relativePath);
  }

  private loadCompanionJson(jsonPath: string): DC6CompanionLayout | null {
    try {
      if (fs.existsSync(jsonPath)) {
        return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      }
    } catch {
      // Ignore
    }
    return null;
  }

  private saveCompanionJson(jsonPath: string, data: object): void {
    const dir = path.dirname(jsonPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  }

  private async openInGimp(compositePath: string): Promise<void> {
    const gimpPath =
      vscode.workspace
        .getConfiguration("d2workshop")
        .get<string>("gimpPath") || "gimp";

    try {
      const { exec } = require("child_process");
      exec(`"${gimpPath}" "${compositePath}"`);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to open GIMP: ${err}. Set the GIMP path in D2 Workshop settings.`
      );
    }
  }
}
