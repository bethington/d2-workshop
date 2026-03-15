"""
Write a file into an MPQ archive using StormLib.
Usage: python mpq_write.py <stormlib_dll> <mpq_path> <internal_name> <data_file>

Prints "OK" on success or "FAIL:<reason>" on failure.
"""
import ctypes
import sys
import os

if len(sys.argv) != 5:
    print("FAIL:usage")
    sys.exit(1)

dll_path, mpq_path, internal_name, data_file = sys.argv[1:]

storm = ctypes.WinDLL(dll_path)
storm.SFileOpenArchive.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
storm.SFileOpenArchive.restype = ctypes.c_bool
storm.SFileCloseArchive.argtypes = [ctypes.c_void_p]
storm.SFileCloseArchive.restype = ctypes.c_bool
storm.SFileRemoveFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint]
storm.SFileRemoveFile.restype = ctypes.c_bool
storm.SFileCreateFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_ulonglong, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
storm.SFileCreateFile.restype = ctypes.c_bool
storm.SFileWriteFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint]
storm.SFileWriteFile.restype = ctypes.c_bool
storm.SFileFinishFile.argtypes = [ctypes.c_void_p]
storm.SFileFinishFile.restype = ctypes.c_bool
storm.SFileHasFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
storm.SFileHasFile.restype = ctypes.c_bool

# Read data
with open(data_file, "rb") as f:
    file_data = f.read()
file_size = len(file_data)

# Open archive in read-write mode (flags=0)
# Retry a few times in case another process briefly holds the file
import time
h = ctypes.c_void_p()
opened = False
for attempt in range(5):
    if storm.SFileOpenArchive(mpq_path.encode(), 0, 0, ctypes.byref(h)):
        opened = True
        break
    time.sleep(0.5)

if not opened:
    last_err = ctypes.windll.kernel32.GetLastError()
    if last_err == 32:
        print(f"FAIL:open - file is locked by another process (error {last_err})")
    else:
        print(f"FAIL:open (error {last_err})")
    sys.exit(1)

fname = internal_name.encode()

# Remove existing file if present
if storm.SFileHasFile(h.value, fname):
    storm.SFileRemoveFile(h.value, fname, 0)

# Create new file (no compression - store as-is, matching D2's original format)
fh = ctypes.c_void_p()
if not storm.SFileCreateFile(h.value, fname, 0, file_size, 0, 0, ctypes.byref(fh)):
    storm.SFileCloseArchive(h.value)
    print("FAIL:create")
    sys.exit(1)

# Write data (no compression)
buf = (ctypes.c_ubyte * file_size)(*file_data)
if not storm.SFileWriteFile(fh.value, buf, file_size, 0):
    storm.SFileCloseArchive(h.value)
    print("FAIL:write")
    sys.exit(1)

# Finish
if not storm.SFileFinishFile(fh.value):
    storm.SFileCloseArchive(h.value)
    print("FAIL:finish")
    sys.exit(1)

storm.SFileCloseArchive(h.value)

# Clean up data file
os.remove(data_file)
print("OK")
