/**
 * StormLib abstraction layer.
 *
 * Supports two backends:
 *   1. Native DLL via PowerShell P/Invoke (development on Windows)
 *   2. WASM via Emscripten (published extension, cross-platform)
 *
 * The backend is selected automatically based on availability.
 */

import { createNativeModule } from "./stormlib-native";

export interface StormLibModule {
  openArchive(path: string, flags: number): number;
  closeArchive(handle: number): boolean;
  listFiles(handle: number): string[];
  readFile(handle: number, fileName: string): Uint8Array | null;
  writeFile(handle: number, fileName: string, data: Uint8Array): boolean;
  hasFile(handle: number, fileName: string): boolean;
  removeFile(handle: number, fileName: string): boolean;
}

/** MPQ open flags */
export const MPQ_OPEN_READ_ONLY = 0x00000100;

let moduleInstance: StormLibModule | null = null;

/**
 * Initialize StormLib. Tries native PowerShell backend first, then WASM.
 */
export async function initStormLib(
  extensionPath?: string
): Promise<StormLibModule> {
  if (moduleInstance) {
    return moduleInstance;
  }

  // Try native PowerShell + DLL backend (Windows development)
  try {
    const native = createNativeModule(extensionPath);
    if (native) {
      console.log(
        "[D2 Workshop] Using native StormLib DLL backend (PowerShell P/Invoke)"
      );
      moduleInstance = native;
      return moduleInstance;
    }
  } catch (err) {
    console.warn(`[D2 Workshop] Native backend failed: ${err}`);
  }

  // Try WASM backend
  try {
    const wasm = await initWasmBackend();
    if (wasm) {
      console.log("[D2 Workshop] Using StormLib WASM backend");
      moduleInstance = wasm;
      return moduleInstance;
    }
  } catch {
    // Fall through to stub
  }

  console.warn(
    "[D2 Workshop] No StormLib backend available. MPQ operations will fail. " +
      "Place StormLib.dll in %TEMP% or set STORMLIB_PATH environment variable."
  );
  moduleInstance = createStub();
  return moduleInstance;
}

export function getStormLib(): StormLibModule {
  if (!moduleInstance) {
    throw new Error("StormLib not initialized. Call initStormLib() first.");
  }
  return moduleInstance;
}

// ─── WASM backend ────────────────────────────────────────────────────

async function initWasmBackend(): Promise<StormLibModule | null> {
  try {
    const pathMod = require("path");
    const fsMod = require("fs");
    const wasmPath = pathMod.join(__dirname, "..", "wasm", "stormlib.js");
    if (!fsMod.existsSync(wasmPath)) {
      return null;
    }

    const CreateStormLib = require(wasmPath);
    const _module = await CreateStormLib();

    // TODO: Implement WASM wrapper using _module.ccall/cwrap
    return null;
  } catch {
    return null;
  }
}

// ─── Stub backend ────────────────────────────────────────────────────

function createStub(): StormLibModule {
  const notImpl = (name: string) => (): never => {
    throw new Error(
      `StormLib not available. ${name}() cannot execute. ` +
        "Place StormLib.dll in %TEMP% or set STORMLIB_PATH, " +
        "or compile StormLib to WASM (see wasm/build-stormlib.sh)."
    );
  };

  return {
    openArchive: notImpl("openArchive") as any,
    closeArchive: notImpl("closeArchive") as any,
    listFiles: notImpl("listFiles") as any,
    readFile: notImpl("readFile") as any,
    writeFile: notImpl("writeFile") as any,
    hasFile: notImpl("hasFile") as any,
    removeFile: notImpl("removeFile") as any,
  };
}
