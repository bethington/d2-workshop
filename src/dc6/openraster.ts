import JSZip from "jszip";
import { PNG } from "pngjs";
import { DC6Frame } from "./dc6-parser";
import { applyPalette, Palette } from "./palette";

/**
 * Create an OpenRaster (.ora) file from DC6 frames.
 * Each frame becomes a separate layer. GIMP can open .ora files natively.
 *
 * ORA format: ZIP archive containing:
 *   - mimetype (uncompressed, first entry)
 *   - stack.xml (layer stack definition)
 *   - data/layer_N.png (each layer as PNG)
 *   - mergedimage.png (flattened preview)
 *   - Thumbnails/thumbnail.png (thumbnail preview)
 */
export async function createOpenRaster(
  frames: DC6Frame[],
  palette: Palette
): Promise<Buffer> {
  const zip = new JSZip();

  // mimetype must be first and uncompressed
  zip.file("mimetype", "image/openraster", { compression: "STORE" });

  // Find max dimensions for canvas size
  let maxW = 0, maxH = 0;
  for (const f of frames) {
    maxW = Math.max(maxW, f.width);
    maxH = Math.max(maxH, f.height);
  }

  // Create each layer as a PNG
  const layerEntries: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const rgba = applyPalette(frame.pixels, palette);

    const png = new PNG({ width: frame.width, height: frame.height });
    png.data = Buffer.from(rgba);
    const pngBuffer = PNG.sync.write(png);

    const layerPath = `data/layer_${i}.png`;
    zip.file(layerPath, pngBuffer);
    layerEntries.push(layerPath);
  }

  // Create stack.xml
  let stackXml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  stackXml += `<image version="0.0.3" w="${maxW}" h="${maxH}">\n`;
  stackXml += `  <stack>\n`;
  for (let i = 0; i < frames.length; i++) {
    const name = `Frame ${i}`;
    stackXml += `    <layer name="${name}" src="${layerEntries[i]}" x="0" y="0" opacity="1.0" visibility="visible" composite-op="svg:src-over" />\n`;
  }
  stackXml += `  </stack>\n`;
  stackXml += `</image>\n`;
  zip.file("stack.xml", stackXml);

  // Create a simple merged image (just the first frame for preview)
  if (frames.length > 0) {
    const firstFrame = frames[0];
    const firstRgba = applyPalette(firstFrame.pixels, palette);
    const mergedPng = new PNG({ width: firstFrame.width, height: firstFrame.height });
    mergedPng.data = Buffer.from(firstRgba);
    const mergedBuffer = PNG.sync.write(mergedPng);
    zip.file("mergedimage.png", mergedBuffer);

    // Thumbnail (same as merged for simplicity)
    zip.file("Thumbnails/thumbnail.png", mergedBuffer);
  }

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf;
}

/**
 * Read an OpenRaster (.ora) file and extract layer PNGs in order.
 * Returns RGBA pixel data for each layer.
 */
export async function readOpenRaster(
  oraBuffer: Buffer
): Promise<Array<{ width: number; height: number; rgba: Buffer }>> {
  const zip = await JSZip.loadAsync(oraBuffer);

  // Parse stack.xml to get layer order
  const stackXml = await zip.file("stack.xml")?.async("string");
  if (!stackXml) throw new Error("Invalid ORA file: missing stack.xml");

  // Extract layer src paths in order
  const layerPaths: string[] = [];
  const layerRegex = /src="([^"]+)"/g;
  let match;
  while ((match = layerRegex.exec(stackXml)) !== null) {
    layerPaths.push(match[1]);
  }

  const layers: Array<{ width: number; height: number; rgba: Buffer }> = [];
  for (const layerPath of layerPaths) {
    const file = zip.file(layerPath);
    if (!file) continue;

    const pngData = await file.async("nodebuffer");
    const png = PNG.sync.read(pngData);
    layers.push({
      width: png.width,
      height: png.height,
      rgba: png.data as unknown as Buffer,
    });
  }

  return layers;
}
