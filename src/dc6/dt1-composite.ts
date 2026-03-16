/**
 * DT1 companion JSON types, group management, and isometric coordinate helpers.
 *
 * Follows the same companion JSON pattern as DC6CompanionLayout in composite.ts.
 */

import { SubTileFlags } from "./dt1-parser";

/** A tile positioned on an isometric canvas */
export interface TilePosition {
  /** Index of the tile in the DT1 file */
  tileIndex: number;
  /** Isometric grid X coordinate */
  isoX: number;
  /** Isometric grid Y coordinate */
  isoY: number;
}

/** A user-defined group of tiles arranged together */
export interface TileGroup {
  /** Display name for the group */
  name: string;
  /** Tiles in this group with their isometric positions */
  tiles: TilePosition[];
}

/** Per-tile neighbor override for the auto-surround view */
export interface SurroundOverride {
  /** Tile index this override applies to */
  tileIndex: number;
  /** Neighbor tile indices by position (null = auto-fill) */
  neighbors: {
    n: number | null;
    ne: number | null;
    e: number | null;
    se: number | null;
    s: number | null;
    sw: number | null;
    w: number | null;
    nw: number | null;
  };
}

/** Modified collision flags for a tile (queued, not yet written) */
export interface CollisionEdit {
  tileIndex: number;
  subTileFlags: SubTileFlags[];
}

/** Companion JSON persisted per DT1 file */
export interface DT1CompanionLayout {
  /** Source DT1 file path */
  source: string;
  /** Palette used for rendering */
  palette: string;
  /** Current view mode */
  viewMode: "single" | "surround" | "grouped" | "tileset";
  /** Zoom level */
  zoom: number;
  /** Active type filter ("all" or type number as string) */
  filterType: string;
  /** Last selected tile index */
  selectedTileIndex: number;
  /** User-defined tile groups */
  groups: TileGroup[];
  /** Active group index (for grouped view mode) */
  activeGroupIndex: number;
  /** Per-tile surround neighbor overrides */
  surroundOverrides: SurroundOverride[];
  /** Pending collision flag edits */
  collisionEdits: CollisionEdit[];
}

/**
 * Generate a default companion layout for a DT1 file.
 */
export function generateDT1Layout(
  sourcePath: string,
  paletteName: string
): DT1CompanionLayout {
  return {
    source: sourcePath,
    palette: paletteName,
    viewMode: "single",
    zoom: 2,
    filterType: "all",
    selectedTileIndex: 0,
    groups: [],
    activeGroupIndex: -1,
    surroundOverrides: [],
    collisionEdits: [],
  };
}

// ─── Isometric Coordinate Helpers ───────────────────────────────────────────

/** Standard D2 floor tile dimensions */
export const ISO_TILE_WIDTH = 160;
export const ISO_TILE_HEIGHT = 80;

/** Half-tile dimensions used for isometric projection */
export const ISO_HALF_W = ISO_TILE_WIDTH / 2;  // 80
export const ISO_HALF_H = ISO_TILE_HEIGHT / 2; // 40

/**
 * Convert isometric grid coordinates to screen pixel coordinates.
 * Uses standard isometric projection for D2-style tiles.
 *
 * @param isoX Isometric grid X
 * @param isoY Isometric grid Y
 * @returns Screen pixel coordinates (top-left of the tile's bounding box)
 */
export function isoToScreen(isoX: number, isoY: number): { x: number; y: number } {
  return {
    x: (isoX - isoY) * ISO_HALF_W,
    y: (isoX + isoY) * ISO_HALF_H,
  };
}

/**
 * Convert screen pixel coordinates to isometric grid coordinates.
 * Inverse of isoToScreen.
 */
export function screenToIso(screenX: number, screenY: number): { isoX: number; isoY: number } {
  return {
    isoX: (screenX / ISO_HALF_W + screenY / ISO_HALF_H) / 2,
    isoY: (screenY / ISO_HALF_H - screenX / ISO_HALF_W) / 2,
  };
}

/**
 * Snap screen coordinates to the nearest isometric grid position.
 */
export function snapToIsoGrid(screenX: number, screenY: number): { isoX: number; isoY: number } {
  const iso = screenToIso(screenX, screenY);
  return {
    isoX: Math.round(iso.isoX),
    isoY: Math.round(iso.isoY),
  };
}

/**
 * Get the 8 neighbor positions around an isometric tile.
 * Returns positions in order: N, NE, E, SE, S, SW, W, NW
 */
export function getNeighborPositions(isoX: number, isoY: number): Array<{
  direction: string;
  isoX: number;
  isoY: number;
}> {
  return [
    { direction: "n",  isoX: isoX,     isoY: isoY - 1 },
    { direction: "ne", isoX: isoX + 1, isoY: isoY - 1 },
    { direction: "e",  isoX: isoX + 1, isoY: isoY     },
    { direction: "se", isoX: isoX + 1, isoY: isoY + 1 },
    { direction: "s",  isoX: isoX,     isoY: isoY + 1 },
    { direction: "sw", isoX: isoX - 1, isoY: isoY + 1 },
    { direction: "w",  isoX: isoX - 1, isoY: isoY     },
    { direction: "nw", isoX: isoX - 1, isoY: isoY - 1 },
  ];
}

/**
 * Calculate the bounding box in screen coordinates for a set of iso positions.
 * Used to determine canvas size for a group or surround view.
 */
export function isoBoundingBox(positions: Array<{ isoX: number; isoY: number }>): {
  minScreenX: number;
  minScreenY: number;
  maxScreenX: number;
  maxScreenY: number;
  width: number;
  height: number;
} {
  let minSX = Infinity, minSY = Infinity;
  let maxSX = -Infinity, maxSY = -Infinity;

  for (const pos of positions) {
    const screen = isoToScreen(pos.isoX, pos.isoY);
    minSX = Math.min(minSX, screen.x);
    minSY = Math.min(minSY, screen.y);
    maxSX = Math.max(maxSX, screen.x + ISO_TILE_WIDTH);
    maxSY = Math.max(maxSY, screen.y + ISO_TILE_HEIGHT);
  }

  return {
    minScreenX: minSX,
    minScreenY: minSY,
    maxScreenX: maxSX,
    maxScreenY: maxSY,
    width: maxSX - minSX,
    height: maxSY - minSY,
  };
}

