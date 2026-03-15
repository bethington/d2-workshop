/**
 * AnimData.d2 file format parser.
 *
 * AnimData files contain animation metadata for all game animations:
 * frames per direction, playback speed, and animation events
 * (attack, missile, sound, skill triggers).
 *
 * Structure: 256 hash-bucketed blocks, each containing up to 67 records.
 */

export enum AnimationEvent {
  None = 0,
  Attack = 1,
  Missile = 2,
  Sound = 3,
  Skill = 4,
}

export const ANIMATION_EVENT_NAMES: Record<number, string> = {
  0: "None", 1: "Attack", 2: "Missile", 3: "Sound", 4: "Skill",
};

export interface AnimDataRecord {
  /** Animation name (e.g., "AMAW1HS") */
  name: string;
  /** Number of frames per direction */
  framesPerDirection: number;
  /** Animation speed (out of 256). FPS = 25 * speed / 256 */
  speed: number;
  /** Event triggers by frame index */
  events: Map<number, AnimationEvent>;
}

export interface AnimDataFile {
  /** All records indexed by name (may have multiple per name) */
  records: Map<string, AnimDataRecord[]>;
  /** Total record count */
  totalRecords: number;
}

const NUM_BLOCKS = 256;
const MAX_RECORDS_PER_BLOCK = 67;
const BYTE_COUNT_NAME = 8;
const NUM_EVENTS = 144;

/**
 * Parse an AnimData.d2 file.
 */
export function parseAnimData(data: Uint8Array): AnimDataFile {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const records = new Map<string, AnimDataRecord[]>();
  let totalRecords = 0;

  for (let blockIdx = 0; blockIdx < NUM_BLOCKS; blockIdx++) {
    const recordCount = view.getUint32(offset, true);
    offset += 4;

    if (recordCount > MAX_RECORDS_PER_BLOCK) {
      throw new Error(`AnimData block ${blockIdx} has ${recordCount} records (max ${MAX_RECORDS_PER_BLOCK})`);
    }

    for (let r = 0; r < recordCount; r++) {
      // Read 8-byte null-terminated name
      let name = "";
      for (let i = 0; i < BYTE_COUNT_NAME; i++) {
        const ch = data[offset + i];
        if (ch !== 0) name += String.fromCharCode(ch);
      }
      offset += BYTE_COUNT_NAME;

      const framesPerDirection = view.getUint32(offset, true);
      offset += 4;

      const speed = view.getUint16(offset, true);
      offset += 2;

      // Skip 2 padding bytes
      offset += 2;

      // Read 144 event bytes
      const events = new Map<number, AnimationEvent>();
      for (let e = 0; e < NUM_EVENTS; e++) {
        const eventByte = data[offset++];
        if (eventByte !== AnimationEvent.None) {
          events.set(e, eventByte as AnimationEvent);
        }
      }

      const record: AnimDataRecord = { name, framesPerDirection, speed, events };

      if (!records.has(name)) {
        records.set(name, []);
      }
      records.get(name)!.push(record);
      totalRecords++;
    }
  }

  return { records, totalRecords };
}

/**
 * Get the actual FPS for a given speed value.
 * FPS = 25 * speed / 256
 */
export function speedToFPS(speed: number): number {
  return (25 * speed) / 256;
}

/**
 * Get the milliseconds per frame for a given speed value.
 */
export function speedToMsPerFrame(speed: number): number {
  const fps = speedToFPS(speed);
  if (fps <= 0) return 100;
  return 1000 / fps;
}

/**
 * Check if data looks like an AnimData file.
 * AnimData files start with a uint32 record count for the first block.
 */
export function isAnimDataFile(data: Uint8Array, fileName: string): boolean {
  if (data.length < 4) return false;
  // AnimData files are typically named "AnimData.d2"
  const lower = fileName.toLowerCase();
  return lower === "animdata.d2" || lower.endsWith("/animdata.d2") || lower.endsWith("\\animdata.d2");
}
