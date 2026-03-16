"""
Schema generator for Diablo II .txt data files.

Reads all .txt files from the game's MPQ archives and auto-generates
JSON schema files by analyzing column data types, value ranges,
cross-references between files, and enum detection.

Usage: python scripts/generate-schemas.py <stormlib_dll> <mpq_dir> <output_dir>
Example: python scripts/generate-schemas.py wasm/StormLib_x64.dll C:\Diablo2 schemas/txt
"""

import ctypes
import json
import os
import sys
from collections import defaultdict

# ── StormLib Setup ──────────────────────────────────────────────────────────

def setup_stormlib(dll_path):
    storm = ctypes.WinDLL(dll_path)
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
    storm.SFileOpenFileEx.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
    storm.SFileOpenFileEx.restype = ctypes.c_bool
    storm.SFileGetFileSize.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint)]
    storm.SFileGetFileSize.restype = ctypes.c_uint
    storm.SFileReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_uint), ctypes.c_void_p]
    storm.SFileReadFile.restype = ctypes.c_bool
    storm.SFileCloseFile.argtypes = [ctypes.c_void_p]
    storm.SFileCloseFile.restype = ctypes.c_bool
    return storm

def read_file(storm, archive_handle, file_path):
    fh = ctypes.c_void_p()
    if not storm.SFileOpenFileEx(archive_handle, file_path.encode(), 0, ctypes.byref(fh)):
        return None
    high = ctypes.c_uint(0)
    sz = storm.SFileGetFileSize(fh.value, ctypes.byref(high))
    if sz == 0 or sz == 0xFFFFFFFF:
        storm.SFileCloseFile(fh.value)
        return None
    buf = (ctypes.c_ubyte * sz)()
    rd = ctypes.c_uint(0)
    storm.SFileReadFile(fh.value, buf, sz, ctypes.byref(rd), None)
    storm.SFileCloseFile(fh.value)
    return bytes(buf[:rd.value])

def list_txt_files(storm, archive_handle):
    files = []
    fd = (ctypes.c_ubyte * 604)()
    fh = storm.SFileFindFirstFile(archive_handle, b"*.txt", fd, None)
    if fh:
        name = ctypes.string_at(fd).decode("ascii", errors="replace")
        files.append(name)
        while storm.SFileFindNextFile(fh, fd):
            name = ctypes.string_at(fd).decode("ascii", errors="replace")
            files.append(name)
        storm.SFileFindClose(fh)
    return files

# ── Data Analysis ───────────────────────────────────────────────────────────

# Files that are not data tables (skip these)
SKIP_FILES = {
    "license.txt", "readme.txt", "credits.txt", "expansioncredits.txt",
    "maccredits.txt", "patch.txt", "reallythelastsucker.txt",
    "chinese.txt", "english.txt", "french.txt", "german.txt",
    "italian.txt", "japanese.txt", "korean.txt", "polish.txt",
    "portuguese.txt", "russian.txt", "spanish.txt",
    "font16.txt", "font24.txt", "font30.txt", "font42.txt",
    "menu24.txt", "menu30.txt", "menu30e.txt", "menu42.txt", "menubrett.txt",
    "bnetd2helpinput.txt", "guildinput.txt", "otheractinput.txt",
    "expansioninput.txt",
}

def parse_txt(data):
    """Parse a tab-delimited txt file into headers + rows."""
    text = data.decode("latin-1")
    lines = [l for l in text.split("\n") if l.strip()]
    if not lines:
        return None, None
    headers = lines[0].rstrip("\r").split("\t")
    rows = []
    for line in lines[1:]:
        cells = line.rstrip("\r").split("\t")
        # Filter expansion separator rows
        if cells and cells[0].lower() == "expansion":
            continue
        rows.append(cells)
    return headers, rows

def is_integer(s):
    if not s or s.strip() == "":
        return True  # empty is compatible with integer
    s = s.strip()
    try:
        int(s)
        return True
    except ValueError:
        return False

def is_boolean(values):
    """Check if all non-empty values are 0 or 1."""
    non_empty = [v.strip() for v in values if v.strip()]
    if not non_empty:
        return False
    return all(v in ("0", "1") for v in non_empty)

def detect_column_type(values, col_name, all_file_names, all_first_columns):
    """Detect the type of a column from its values."""
    non_empty = [v.strip() for v in values if v.strip()]

    if not non_empty:
        return {"type": "string"}

    # Check for boolean (all 0/1)
    if is_boolean(values):
        return {"type": "boolean"}

    # Check for integer
    if all(is_integer(v) for v in values):
        int_vals = [int(v.strip()) for v in non_empty]
        result = {"type": "integer"}
        if int_vals:
            result["min"] = min(int_vals)
            result["max"] = max(int_vals)
        return result

    # Check for reference to another file
    col_lower = col_name.lower()
    for fname, first_col_values in all_first_columns.items():
        fname_base = fname.replace(".txt", "").lower()
        # Column name matches file name (e.g., "hitclass" → "hitclass.txt")
        if col_lower == fname_base or col_lower == fname_base + "id":
            overlap = len(set(non_empty) & first_col_values)
            if overlap > 0 and overlap >= len(set(non_empty)) * 0.3:
                return {
                    "type": "ref",
                    "target": fname,
                    "targetColumn": list(first_col_values)[0] if len(first_col_values) == 1 else col_name,
                }

    # Check for enum (few unique values)
    unique = sorted(set(non_empty))
    if 2 <= len(unique) <= 20:
        return {"type": "enum", "values": unique}

    return {"type": "string"}

# ── Schema Generation ───────────────────────────────────────────────────────

def generate_schema(file_name, headers, rows, all_file_names, all_first_columns):
    """Generate a schema for a single txt file."""
    schema = {
        "file": file_name,
        "description": f"Auto-generated schema for {file_name}",
        "columns": {}
    }

    for col_idx, header in enumerate(headers):
        if not header.strip():
            continue

        # Collect all values for this column
        values = []
        for row in rows:
            if col_idx < len(row):
                values.append(row[col_idx])
            else:
                values.append("")

        col_schema = detect_column_type(values, header, all_file_names, all_first_columns)

        # Mark first column as required + unique (usually the key)
        if col_idx == 0:
            col_schema["required"] = True
            non_empty = [v.strip() for v in values if v.strip()]
            if len(non_empty) == len(set(non_empty)):
                col_schema["unique"] = True

        schema["columns"][header] = col_schema

    return schema

# ── Main ────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 4:
        print("Usage: python generate-schemas.py <stormlib_dll> <mpq_dir> <output_dir>")
        sys.exit(1)

    dll_path = sys.argv[1]
    mpq_dir = sys.argv[2]
    output_dir = sys.argv[3]

    storm = setup_stormlib(dll_path)
    os.makedirs(output_dir, exist_ok=True)

    # Collect all txt files from all MPQs
    mpq_files = [f for f in os.listdir(mpq_dir) if f.lower().endswith(".mpq")]
    all_files = {}  # filename → (headers, rows)
    all_file_names = set()

    for mpq_name in mpq_files:
        mpq_path = os.path.join(mpq_dir, mpq_name)
        h = ctypes.c_void_p()
        if not storm.SFileOpenArchive(mpq_path.encode(), 0, 0x100, ctypes.byref(h)):
            continue

        txt_files = list_txt_files(storm, h.value)
        for file_path in txt_files:
            basename = file_path.replace("\\", "/").split("/")[-1].lower()
            if basename in SKIP_FILES:
                continue
            if basename in all_files:
                continue  # Already have this file from a higher-priority MPQ

            data = read_file(storm, h.value, file_path)
            if not data:
                continue

            headers, rows = parse_txt(data)
            if not headers or not rows:
                continue

            all_files[basename] = (headers, rows)
            all_file_names.add(basename)

        storm.SFileCloseArchive(h.value)

    print(f"Loaded {len(all_files)} data files from {len(mpq_files)} MPQs")

    # Build first-column value sets for cross-reference detection
    all_first_columns = {}
    for fname, (headers, rows) in all_files.items():
        if headers:
            values = set()
            for row in rows:
                if row and row[0].strip():
                    values.add(row[0].strip())
            if values:
                all_first_columns[fname] = values

    # Generate schemas
    generated = 0
    skipped = 0

    for fname, (headers, rows) in sorted(all_files.items()):
        schema_name = fname.replace(".txt", ".schema.json")
        output_path = os.path.join(output_dir, schema_name)

        # Skip if a hand-written schema already exists
        if os.path.exists(output_path):
            # Check if it's hand-written (has descriptions)
            try:
                existing = json.load(open(output_path))
                has_descriptions = any(
                    "description" in v and v["description"] != ""
                    for v in existing.get("columns", {}).values()
                )
                if has_descriptions:
                    print(f"  SKIP {fname} (hand-written schema exists)")
                    skipped += 1
                    continue
            except:
                pass

        schema = generate_schema(fname, headers, rows, all_file_names, all_first_columns)

        with open(output_path, "w") as f:
            json.dump(schema, f, indent=2)

        col_types = defaultdict(int)
        for col in schema["columns"].values():
            col_types[col["type"]] += 1

        type_summary = ", ".join(f"{t}:{c}" for t, c in sorted(col_types.items()))
        print(f"  GEN  {fname} ({len(headers)} cols: {type_summary})")
        generated += 1

    print(f"\nDone: {generated} generated, {skipped} skipped (hand-written)")

if __name__ == "__main__":
    main()
