/**
 * Test StormLib 64-bit DLL via Python ctypes.
 * Run: node test-stormlib.js [path-to-mpq]
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const dllPath = path.join(__dirname, "wasm", "StormLib_x64.dll");
if (!fs.existsSync(dllPath)) {
  console.error("StormLib_x64.dll not found at:", dllPath);
  process.exit(1);
}
console.log("Using StormLib:", dllPath);

const mpqPath = process.argv[2] || "C:\\Diablo2\\d2data.mpq";
if (!fs.existsSync(mpqPath)) {
  console.error("MPQ not found:", mpqPath);
  process.exit(1);
}
console.log("Opening MPQ:", mpqPath);

const script = `
import ctypes, json
storm = ctypes.WinDLL(r"${dllPath.replace(/\\/g, "\\\\")}")
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
ok = storm.SFileOpenArchive(rb"${mpqPath.replace(/\\/g, "\\\\")}", 0, 0x100, ctypes.byref(h))
if not ok:
    print("FAILED to open archive")
    exit(1)
print("Archive opened successfully")

fd = (ctypes.c_byte * 604)()
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

print(f"Total files: {len(files)}")
for f in files[:20]:
    print(f"  {f}")
if len(files) > 20:
    print(f"  ... and {len(files) - 20} more")

# Print some txt files
txt_files = [f for f in files if f.lower().endswith('.txt')]
print(f"\\nTXT files ({len(txt_files)}):")
for f in txt_files[:10]:
    print(f"  {f}")

# Print some dc6 files
dc6_files = [f for f in files if f.lower().endswith('.dc6')]
print(f"\\nDC6 files ({len(dc6_files)}):")
for f in dc6_files[:10]:
    print(f"  {f}")
`;

try {
  const output = execFileSync("python", ["-c", script], {
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 50 * 1024 * 1024,
  });
  console.log(output);
} catch (err) {
  console.error("Error:", err.message);
  if (err.stderr) console.error("STDERR:", err.stderr.toString());
}
