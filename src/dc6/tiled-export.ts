/**
 * Tiled tileset export for DT1 files.
 *
 * Exports DT1 tiles as a Tiled-compatible tileset with:
 * - Sprite sheet PNG (all tiles packed in a grid)
 * - Tileset definition in .tsx (XML) or .tsj (JSON) format
 * - Per-tile properties (type, style, collision flags)
 */

import { PNG } from "pngjs";
import { DT1Tile, decodeTileGfx, TILE_ORIENTATIONS } from "./dt1-parser";
import { applyPalette, Palette } from "./palette";

interface TiledTileProperty {
  name: string;
  type: string;
  value: string | number | boolean;
}

/**
 * Generate a sprite sheet PNG from DT1 tiles.
 * Returns the PNG buffer and metadata about tile positions.
 */
export function generateSpriteSheet(
  tiles: DT1Tile[],
  palette: Palette
): { pngBuffer: Buffer; tileWidth: number; tileHeight: number; columns: number } {
  if (tiles.length === 0) {
    const empty = new PNG({ width: 1, height: 1 });
    return { pngBuffer: PNG.sync.write(empty), tileWidth: 1, tileHeight: 1, columns: 1 };
  }

  // Find max tile dimensions for uniform grid cells
  let maxW = 0, maxH = 0;
  for (const t of tiles) {
    maxW = Math.max(maxW, Math.abs(t.width) || 160);
    maxH = Math.max(maxH, Math.abs(t.height) || 80);
  }

  const columns = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / columns);
  const sheetW = columns * maxW;
  const sheetH = rows * maxH;

  const png = new PNG({ width: sheetW, height: sheetH });
  // Fill with transparent
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 0;
  }

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const w = Math.abs(tile.width) || 160;
    const h = Math.abs(tile.height) || 80;
    const col = i % columns;
    const row = Math.floor(i / columns);

    try {
      const pixels = decodeTileGfx(tile.blocks, w, h);
      const rgba = applyPalette(pixels, palette);

      // Blit tile RGBA into sprite sheet
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const srcIdx = (y * w + x) * 4;
          const dstX = col * maxW + x;
          const dstY = row * maxH + y;
          const dstIdx = (dstY * sheetW + dstX) * 4;

          if (rgba[srcIdx + 3] > 0) {
            png.data[dstIdx] = rgba[srcIdx];
            png.data[dstIdx + 1] = rgba[srcIdx + 1];
            png.data[dstIdx + 2] = rgba[srcIdx + 2];
            png.data[dstIdx + 3] = rgba[srcIdx + 3];
          }
        }
      }
    } catch {
      // Skip tiles that fail to decode
    }
  }

  return {
    pngBuffer: PNG.sync.write(png),
    tileWidth: maxW,
    tileHeight: maxH,
    columns,
  };
}

/**
 * Generate a Tiled tileset JSON (.tsj) definition.
 */
export function generateTilesetJSON(
  tiles: DT1Tile[],
  imagePath: string,
  tileWidth: number,
  tileHeight: number,
  columns: number,
  imageWidth: number,
  imageHeight: number
): string {
  const tileProperties: Array<{
    id: number;
    properties: TiledTileProperty[];
  }> = [];

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const props: TiledTileProperty[] = [
      { name: "d2_type", type: "int", value: tile.type },
      { name: "d2_type_name", type: "string", value: TILE_ORIENTATIONS[tile.type] || `Type ${tile.type}` },
      { name: "d2_style", type: "int", value: tile.style },
      { name: "d2_sequence", type: "int", value: tile.sequence },
      { name: "d2_direction", type: "int", value: tile.direction },
    ];

    // Add collision flags for first subtile as example
    if (tile.subTileFlags.length > 0) {
      const f = tile.subTileFlags[0];
      props.push({ name: "d2_block_walk", type: "bool", value: f.blockWalk });
      props.push({ name: "d2_block_los", type: "bool", value: f.blockLOS });
    }

    tileProperties.push({ id: i, properties: props });
  }

  const tileset = {
    columns,
    image: imagePath,
    imageheight: imageHeight,
    imagewidth: imageWidth,
    margin: 0,
    name: "D2 Tileset",
    spacing: 0,
    tilecount: tiles.length,
    tiledversion: "1.10",
    tileheight: tileHeight,
    tilewidth: tileWidth,
    type: "tileset",
    version: "1.10",
    tiles: tileProperties,
  };

  return JSON.stringify(tileset, null, 2);
}

/**
 * Generate a Tiled tileset XML (.tsx) definition.
 */
export function generateTilesetXML(
  tiles: DT1Tile[],
  imagePath: string,
  tileWidth: number,
  tileHeight: number,
  columns: number,
  imageWidth: number,
  imageHeight: number
): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<tileset version="1.10" tiledversion="1.10" name="D2 Tileset" `;
  xml += `tilewidth="${tileWidth}" tileheight="${tileHeight}" `;
  xml += `tilecount="${tiles.length}" columns="${columns}">\n`;
  xml += ` <image source="${imagePath}" width="${imageWidth}" height="${imageHeight}"/>\n`;

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    xml += ` <tile id="${i}">\n`;
    xml += `  <properties>\n`;
    xml += `   <property name="d2_type" type="int" value="${tile.type}"/>\n`;
    xml += `   <property name="d2_type_name" value="${TILE_ORIENTATIONS[tile.type] || `Type ${tile.type}`}"/>\n`;
    xml += `   <property name="d2_style" type="int" value="${tile.style}"/>\n`;
    xml += `   <property name="d2_sequence" type="int" value="${tile.sequence}"/>\n`;
    xml += `   <property name="d2_direction" type="int" value="${tile.direction}"/>\n`;

    if (tile.subTileFlags.length > 0) {
      const f = tile.subTileFlags[0];
      xml += `   <property name="d2_block_walk" type="bool" value="${f.blockWalk}"/>\n`;
      xml += `   <property name="d2_block_los" type="bool" value="${f.blockLOS}"/>\n`;
    }

    xml += `  </properties>\n`;
    xml += ` </tile>\n`;
  }

  xml += `</tileset>\n`;
  return xml;
}
