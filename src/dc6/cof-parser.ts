/**
 * COF (Composite Object File) format parser.
 *
 * COF files define how multiple DCC/DC6 sprite layers are composited
 * into a full character/monster animation. They specify layer order,
 * rendering priority, animation speed, and draw effects.
 */

/** Composite layer types in Diablo II */
export enum CompositeType {
  Head = 0, Torso = 1, Legs = 2, RightArm = 3, LeftArm = 4,
  RightHand = 5, LeftHand = 6, Shield = 7, Special1 = 8,
  Special2 = 9, Special3 = 10, Special4 = 11, Special5 = 12,
  Special6 = 13, Special7 = 14, Special8 = 15,
}

export const COMPOSITE_NAMES: Record<number, string> = {
  0: "Head", 1: "Torso", 2: "Legs", 3: "Right Arm", 4: "Left Arm",
  5: "Right Hand", 6: "Left Hand", 7: "Shield", 8: "Special 1",
  9: "Special 2", 10: "Special 3", 11: "Special 4", 12: "Special 5",
  13: "Special 6", 14: "Special 7", 15: "Special 8",
};

export enum DrawEffect {
  None = 0, Trans25 = 1, Trans50 = 2, Trans75 = 3,
  FlipY = 4, NoColor = 5, Shadow = 6,
}

export interface CofLayer {
  type: CompositeType;
  shadow: number;
  selectable: boolean;
  transparent: boolean;
  drawEffect: DrawEffect;
  weaponClass: string;
}

export interface COFFile {
  numberOfLayers: number;
  framesPerDirection: number;
  numberOfDirections: number;
  speed: number;
  layers: CofLayer[];
  animationFrames: number[];
  /** priority[direction][frame][layerIdx] = CompositeType */
  priority: number[][][];
}

/**
 * Parse a COF file from binary data.
 */
export function parseCOF(data: Uint8Array): COFFile {
  const NUM_HEADER_BYTES = 25; // 4 known + 21 unknown
  const NUM_BODY_UNKNOWN = 3;
  const NUM_LAYER_BYTES = 9;

  let offset = 0;

  const numberOfLayers = data[0];
  const framesPerDirection = data[1];
  const numberOfDirections = data[2];
  // bytes 3-23: unknown header bytes
  const speed = data[24];
  offset = NUM_HEADER_BYTES;

  // Skip unknown body bytes
  offset += NUM_BODY_UNKNOWN;

  // Read layers
  const layers: CofLayer[] = [];
  for (let i = 0; i < numberOfLayers; i++) {
    const type = data[offset] as CompositeType;
    const shadow = data[offset + 1];
    const selectable = data[offset + 2] > 0;
    const transparent = data[offset + 3] > 0;
    const drawEffect = data[offset + 4] as DrawEffect;

    // Weapon class: null-terminated string in remaining bytes
    let weaponClass = "";
    for (let j = 5; j < NUM_LAYER_BYTES; j++) {
      const ch = data[offset + j];
      if (ch === 0) break;
      weaponClass += String.fromCharCode(ch);
    }

    layers.push({ type, shadow, selectable, transparent, drawEffect, weaponClass: weaponClass.trim() });
    offset += NUM_LAYER_BYTES;
  }

  // Read animation frames
  const animationFrames: number[] = [];
  for (let i = 0; i < framesPerDirection; i++) {
    animationFrames.push(data[offset++]);
  }

  // Read priority table: [direction][frame][layer] = CompositeType
  const priority: number[][][] = [];
  for (let d = 0; d < numberOfDirections; d++) {
    priority[d] = [];
    for (let f = 0; f < framesPerDirection; f++) {
      priority[d][f] = [];
      for (let l = 0; l < numberOfLayers; l++) {
        priority[d][f][l] = data[offset++];
      }
    }
  }

  return {
    numberOfLayers, framesPerDirection, numberOfDirections, speed,
    layers, animationFrames, priority,
  };
}

/**
 * Check if data looks like a COF file.
 * COF files have no magic signature, so we check if the structure is plausible.
 */
export function isCOFFile(data: Uint8Array): boolean {
  if (data.length < 28) return false;
  const layers = data[0];
  const frames = data[1];
  const dirs = data[2];
  if (layers === 0 || layers > 16) return false;
  if (frames === 0 || frames > 256) return false;
  if (dirs === 0 || (dirs !== 1 && dirs !== 4 && dirs !== 8 && dirs !== 16 && dirs !== 32)) return false;
  const expectedSize = 25 + 3 + layers * 9 + frames + frames * dirs * layers;
  return data.length >= expectedSize;
}
