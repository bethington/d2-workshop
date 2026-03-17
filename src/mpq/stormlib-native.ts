/**
 * Native StormLib backend using a Python ctypes bridge process.
 *
 * Spawns a persistent Python child process that loads the 64-bit StormLib.dll
 * and communicates via JSON over stdin/stdout. This avoids the overhead of
 * spawning a new process for each MPQ operation.
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { StormLibModule } from "./stormlib-wasm";

/**
 * Find the 64-bit StormLib DLL.
 */
function findStormLib64(extensionPath?: string): string | null {
  const candidates = [
    process.env.STORMLIB_X64_PATH,
    // Bundled with extension
    extensionPath
      ? path.join(extensionPath, "wasm", "StormLib_x64.dll")
      : undefined,
    // __dirname is dist/ when bundled — go up one level
    path.join(__dirname, "..", "wasm", "StormLib_x64.dll"),
    // Also try two levels (unbundled)
    path.join(__dirname, "..", "..", "wasm", "StormLib_x64.dll"),
    // TEMP folder
    path.join(process.env.TEMP || "", "StormLib_x64.dll"),
  ].filter(Boolean) as string[];

  console.log("[D2 Workshop] Searching for StormLib_x64.dll:", candidates);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Python bridge script that runs as a persistent child process.
 */
function getPythonScript(dllPath: string): string {
  return `
import ctypes
import ctypes.wintypes as wt
import json
import sys
import os

# Load StormLib
storm = ctypes.WinDLL(r"${dllPath.replace(/\\/g, "\\\\")}")

# Define function signatures
storm.SFileOpenArchive.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
storm.SFileOpenArchive.restype = ctypes.c_bool
storm.SFileCloseArchive.argtypes = [ctypes.c_void_p]
storm.SFileCloseArchive.restype = ctypes.c_bool
storm.SFileHasFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
storm.SFileHasFile.restype = ctypes.c_bool
storm.SFileOpenFileEx.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
storm.SFileOpenFileEx.restype = ctypes.c_bool
storm.SFileGetFileSize.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint)]
storm.SFileGetFileSize.restype = ctypes.c_uint
storm.SFileReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_uint), ctypes.c_void_p]
storm.SFileReadFile.restype = ctypes.c_bool
storm.SFileCloseFile.argtypes = [ctypes.c_void_p]
storm.SFileCloseFile.restype = ctypes.c_bool

# SFILE_FIND_DATA: first 260 bytes = filename (null-terminated)
FIND_DATA_SIZE = 604
storm.SFileFindFirstFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_char_p]
storm.SFileFindFirstFile.restype = ctypes.c_void_p
storm.SFileFindNextFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
storm.SFileFindNextFile.restype = ctypes.c_bool
storm.SFileFindClose.argtypes = [ctypes.c_void_p]
storm.SFileFindClose.restype = ctypes.c_bool

import base64

handles = {}
next_id = 1

def process_command(cmd):
    global next_id
    action = cmd["action"]

    if action == "open":
        h = ctypes.c_void_p()
        ok = storm.SFileOpenArchive(cmd["path"].encode(), 0, cmd.get("flags", 0x100), ctypes.byref(h))
        if not ok:
            return {"error": f"Failed to open: {cmd['path']}"}
        hid = next_id
        next_id += 1
        handles[hid] = h.value
        return {"handle": hid}

    elif action == "close":
        hval = handles.pop(cmd["handle"], None)
        if hval is not None:
            storm.SFileCloseArchive(hval)
        return {"ok": True}

    elif action == "list":
        hval = handles.get(cmd["handle"])
        if hval is None:
            return {"error": "Invalid handle"}
        find_data = (ctypes.c_byte * FIND_DATA_SIZE)()
        fh = storm.SFileFindFirstFile(hval, b"*", find_data, None)
        files = []
        if fh:
            name = ctypes.string_at(find_data).decode("ascii", errors="replace")
            if name and not name.startswith("("):
                files.append(name)
            while storm.SFileFindNextFile(fh, find_data):
                name = ctypes.string_at(find_data).decode("ascii", errors="replace")
                if name and not name.startswith("("):
                    files.append(name)
            storm.SFileFindClose(fh)
        return {"files": files}

    elif action == "read":
        hval = handles.get(cmd["handle"])
        if hval is None:
            return {"error": "Invalid handle"}
        fh = ctypes.c_void_p()
        if not storm.SFileOpenFileEx(hval, cmd["file"].encode(), 0, ctypes.byref(fh)):
            return {"error": f"File not found: {cmd['file']}"}
        high = ctypes.c_uint(0)
        size = storm.SFileGetFileSize(fh.value, ctypes.byref(high))
        if size == 0 or size == 0xFFFFFFFF:
            storm.SFileCloseFile(fh.value)
            return {"error": "Invalid file size"}
        buf = (ctypes.c_byte * size)()
        read = ctypes.c_uint(0)
        storm.SFileReadFile(fh.value, buf, size, ctypes.byref(read), None)
        storm.SFileCloseFile(fh.value)
        data = bytes(buf[:read.value])
        return {"data": base64.b64encode(data).decode()}

    elif action == "has":
        hval = handles.get(cmd["handle"])
        if hval is None:
            return {"error": "Invalid handle"}
        result = storm.SFileHasFile(hval, cmd["file"].encode())
        return {"result": bool(result)}

    elif action == "ping":
        return {"ok": True}

    else:
        return {"error": f"Unknown action: {action}"}

# Main loop: read JSON commands from stdin, write JSON responses to stdout
sys.stdout.write("READY\\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        cmd = json.loads(line)
        result = process_command(cmd)
    except Exception as e:
        result = {"error": str(e)}
    sys.stdout.write(json.dumps(result) + "\\n")
    sys.stdout.flush()
`;
}

/**
 * Persistent Python bridge process for StormLib operations.
 */
class StormLibBridge {
  private process: ChildProcess | null = null;
  private ready = false;
  private pendingRequests: Array<{
    resolve: (value: any) => void;
    reject: (err: Error) => void;
  }> = [];
  private buffer = "";

  constructor(private readonly dllPath: string) {}

  async start(): Promise<void> {
    const script = getPythonScript(this.dllPath);

    this.process = spawn("python", ["-u", "-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Python bridge startup timeout"));
      }, 10000);

      this.process!.stdout!.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed === "READY") {
            this.ready = true;
            clearTimeout(timeout);
            resolve();
            continue;
          }

          if (this.pendingRequests.length > 0) {
            const req = this.pendingRequests.shift()!;
            try {
              const result = JSON.parse(trimmed);
              if (result.error) {
                req.reject(new Error(result.error));
              } else {
                req.resolve(result);
              }
            } catch (err) {
              req.reject(new Error(`Invalid JSON response: ${trimmed}`));
            }
          }
        }
      });

      this.process!.stderr!.on("data", (data: Buffer) => {
        console.warn(`[StormLib Bridge] ${data.toString().trim()}`);
      });

      this.process!.on("exit", (code) => {
        this.ready = false;
        if (code !== 0) {
          console.warn(`[StormLib Bridge] Process exited with code ${code}`);
        }
        // Reject any pending requests
        for (const req of this.pendingRequests) {
          req.reject(new Error("Bridge process exited"));
        }
        this.pendingRequests = [];
      });
    });
  }

  async send(command: Record<string, any>): Promise<any> {
    if (!this.ready || !this.process) {
      throw new Error("Bridge not ready");
    }

    return new Promise<any>((resolve, reject) => {
      this.pendingRequests.push({ resolve, reject });
      this.process!.stdin!.write(JSON.stringify(command) + "\n");
    });
  }

  stop(): void {
    if (this.process) {
      this.process.stdin!.end();
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }
}

let bridge: StormLibBridge | null = null;

/**
 * Create a StormLib module backed by a persistent Python process.
 */
export function createNativeModule(extensionPath?: string): StormLibModule | null {
  if (process.platform !== "win32") {
    return null;
  }

  const dllPath = findStormLib64(extensionPath);
  if (!dllPath) {
    return null;
  }

  // We'll lazily start the bridge on first use
  let bridgeStarted = false;

  async function ensureBridge(): Promise<StormLibBridge> {
    if (!bridge || !bridgeStarted) {
      bridge = new StormLibBridge(dllPath!);
      await bridge.start();
      bridgeStarted = true;
    }
    return bridge;
  }

  // Since the StormLibModule interface is synchronous, we need to
  // use synchronous IPC. We'll use execFileSync for individual
  // commands as a simpler approach.
  // For performance, we cache file listings.

  const fileListCache = new Map<number, string[]>();
  const archivePaths = new Map<number, string>();
  let nextHandle = 1;

  return {
    openArchive(mpqPath: string, _flags: number): number {
      if (!fs.existsSync(mpqPath)) {
        throw new Error(`MPQ not found: ${mpqPath}`);
      }
      const handle = nextHandle++;
      archivePaths.set(handle, mpqPath);
      return handle;
    },

    closeArchive(handle: number): boolean {
      fileListCache.delete(handle);
      return archivePaths.delete(handle);
    },

    listFiles(handle: number): string[] {
      if (fileListCache.has(handle)) {
        return fileListCache.get(handle)!;
      }

      const mpqPath = archivePaths.get(handle);
      if (!mpqPath) throw new Error("Invalid handle");

      const escapedMpqPath = mpqPath.replace(/\\/g, "\\\\");

      // Use a one-shot Python script for listing (synchronous)
      const script = `
import ctypes, json, sys
storm = ctypes.WinDLL(r"${dllPath!.replace(/\\/g, "\\\\")}")
storm.SFileOpenArchive.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
storm.SFileOpenArchive.restype = ctypes.c_bool
storm.SFileCloseArchive.argtypes = [ctypes.c_void_p]
storm.SFileCloseArchive.restype = ctypes.c_bool
storm.SFileFindFirstFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_char_p]
storm.SFileFindFirstFile.restype = ctypes.c_void_p
storm.SFileFindNextFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
storm.SFileFindNextFile.restype = ctypes.c_bool
storm.SFileFindClose.argtypes = [ctypes.c_void_p]
storm.SFileFindClose.restype = ctypes.c_bool
h = ctypes.c_void_p()
storm.SFileOpenArchive(b"${escapedMpqPath}", 0, 0x100, ctypes.byref(h))
fd = (ctypes.c_ubyte * 604)()
fh = storm.SFileFindFirstFile(h.value, b"*", fd, None)
files = []
if fh:
    n = ctypes.string_at(fd).decode("ascii", errors="replace")
    if n and not n.startswith("("): files.append(n)
    while storm.SFileFindNextFile(fh, fd):
        n = ctypes.string_at(fd).decode("ascii", errors="replace")
        if n and not n.startswith("("): files.append(n)
    storm.SFileFindClose(fh)
storm.SFileCloseArchive(h.value)
print(json.dumps(files))
`;

      const { execFileSync } = require("child_process");
      const output = execFileSync("python", ["-c", script], {
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 50 * 1024 * 1024,
      }).trim();

      const files = JSON.parse(output) as string[];
      fileListCache.set(handle, files);
      return files;
    },

    readFile(handle: number, fileName: string): Uint8Array | null {
      const mpqPath = archivePaths.get(handle);
      if (!mpqPath) throw new Error("Invalid handle");

      // StormLib requires backslash paths. Use b"..." (not rb"...")
      // so Python interprets \\ as single backslash.
      const escapedMpqPath = mpqPath.replace(/\\/g, "\\\\");
      const escapedFileName = fileName.replace(/\\/g, "\\\\");

      const script = `
import ctypes, sys, base64
storm = ctypes.WinDLL(r"${dllPath!.replace(/\\/g, "\\\\")}")
storm.SFileOpenArchive.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
storm.SFileOpenArchive.restype = ctypes.c_bool
storm.SFileCloseArchive.argtypes = [ctypes.c_void_p]
storm.SFileCloseArchive.restype = ctypes.c_bool
storm.SFileOpenFileEx.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
storm.SFileOpenFileEx.restype = ctypes.c_bool
storm.SFileGetFileSize.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint)]
storm.SFileGetFileSize.restype = ctypes.c_uint
storm.SFileReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_uint), ctypes.c_void_p]
storm.SFileReadFile.restype = ctypes.c_bool
storm.SFileCloseFile.argtypes = [ctypes.c_void_p]
storm.SFileCloseFile.restype = ctypes.c_bool
h = ctypes.c_void_p()
storm.SFileOpenArchive(b"${escapedMpqPath}", 0, 0x100, ctypes.byref(h))
fh = ctypes.c_void_p()
if not storm.SFileOpenFileEx(h.value, b"${escapedFileName}", 0, ctypes.byref(fh)):
    storm.SFileCloseArchive(h.value)
    print("null")
    sys.exit()
high = ctypes.c_uint(0)
sz = storm.SFileGetFileSize(fh.value, ctypes.byref(high))
buf = (ctypes.c_ubyte * sz)()
rd = ctypes.c_uint(0)
storm.SFileReadFile(fh.value, buf, sz, ctypes.byref(rd), None)
storm.SFileCloseFile(fh.value)
storm.SFileCloseArchive(h.value)
print(base64.b64encode(bytes(buf[:rd.value])).decode())
`;

      const { execFileSync } = require("child_process");
      try {
        const output = execFileSync("python", ["-c", script], {
          encoding: "utf-8",
          timeout: 30000,
          maxBuffer: 50 * 1024 * 1024,
        }).trim();

        if (output === "null") return null;
        return new Uint8Array(Buffer.from(output, "base64"));
      } catch {
        return null;
      }
    },

    writeFile(handle: number, fileName: string, data: Uint8Array): boolean {
      const mpqPath = archivePaths.get(handle);
      if (!mpqPath) throw new Error("Invalid handle");

      // Write data to a temp file
      const os = require("os");
      const tmpDataPath = path.join(os.tmpdir(), `d2w_mpqwrite_${Date.now()}.bin`);
      fs.writeFileSync(tmpDataPath, Buffer.from(data));

      // Find the bundled mpq_write.py script
      const scriptPath = path.join(path.dirname(dllPath!), "mpq_write.py");
      if (!fs.existsSync(scriptPath)) {
        fs.unlinkSync(tmpDataPath);
        throw new Error(`mpq_write.py not found at ${scriptPath}`);
      }

      const { execFileSync } = require("child_process");
      try {
        const output = execFileSync("python", [
          scriptPath,
          dllPath!,
          mpqPath,
          fileName,
          tmpDataPath,
        ], {
          encoding: "utf-8",
          timeout: 30000,
          maxBuffer: 50 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();

        if (output !== "OK") {
          console.error(`[StormLib] Write failed: ${output}`);
          return false;
        }

        // Invalidate cache since archive was modified
        fileListCache.delete(handle);
        return true;
      } catch (err: any) {
        try { fs.unlinkSync(tmpDataPath); } catch {}
        const stderr = err?.stderr?.toString?.() || "";
        const stdout = err?.stdout?.toString?.() || "";
        console.error(`[StormLib] Write error stdout: ${stdout}`);
        console.error(`[StormLib] Write error stderr: ${stderr}`);
        console.error(`[StormLib] Write error:`, err?.message || err);
        return false;
      }
    },

    hasFile(handle: number, fileName: string): boolean {
      const mpqPath = archivePaths.get(handle);
      if (!mpqPath) throw new Error("Invalid handle");

      const escapedMpqPath = mpqPath.replace(/\\/g, "\\\\");
      const escapedFileName = fileName.replace(/\\/g, "\\\\");

      const script = `
import ctypes
storm = ctypes.WinDLL(r"${dllPath!.replace(/\\/g, "\\\\")}")
storm.SFileOpenArchive.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
storm.SFileOpenArchive.restype = ctypes.c_bool
storm.SFileCloseArchive.argtypes = [ctypes.c_void_p]
storm.SFileCloseArchive.restype = ctypes.c_bool
storm.SFileHasFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
storm.SFileHasFile.restype = ctypes.c_bool
h = ctypes.c_void_p()
storm.SFileOpenArchive(b"${escapedMpqPath}", 0, 0x100, ctypes.byref(h))
r = storm.SFileHasFile(h.value, b"${escapedFileName}")
storm.SFileCloseArchive(h.value)
print(r)
`;

      const { execFileSync } = require("child_process");
      const output = execFileSync("python", ["-c", script], {
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
      return output === "True";
    },

    removeFile(handle: number, fileName: string): boolean {
      const mpqPath = archivePaths.get(handle);
      if (!mpqPath) throw new Error("Invalid handle");

      const escapedMpqPath = mpqPath.replace(/\\/g, "\\\\");
      const escapedFileName = fileName.replace(/\\/g, "\\\\");

      const script = `
import ctypes
storm = ctypes.WinDLL(r"${dllPath!.replace(/\\/g, "\\\\")}")
storm.SFileOpenArchive.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
storm.SFileOpenArchive.restype = ctypes.c_bool
storm.SFileCloseArchive.argtypes = [ctypes.c_void_p]
storm.SFileCloseArchive.restype = ctypes.c_bool
storm.SFileRemoveFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint]
storm.SFileRemoveFile.restype = ctypes.c_bool
h = ctypes.c_void_p()
storm.SFileOpenArchive(b"${escapedMpqPath}", 0, 0, ctypes.byref(h))
r = storm.SFileRemoveFile(h.value, b"${escapedFileName}", 0)
storm.SFileCloseArchive(h.value)
print(r)
`;

      const { execFileSync } = require("child_process");
      try {
        const output = execFileSync("python", ["-c", script], {
          encoding: "utf-8",
          timeout: 10000,
        }).trim();
        return output === "True";
      } catch {
        return false;
      }
    },
  };
}
