# D2 Workshop

A VS Code extension for Diablo II 1.13c modding. Browse MPQ archives, edit game data tables, view and edit DC6 sprites, patch binaries, and share mods.

## Features

### MPQ Archive Browser
- Browse MPQ archive contents in a tree view
- Virtual `d2mpq://` filesystem lets you open files from MPQ archives directly
- Read and write files inside MPQ archives using StormLib

### Table Editor
- Edit `.txt` data tables (armor.txt, skills.txt, monstats.txt, etc.) with a spreadsheet-style UI
- Schema-aware column descriptions and validation
- Queue changes before publishing to preserve the original files

### DC6 Sprite Viewer & Editor
- View DC6 sprite images with palette rendering (Act 1-5 palettes + custom palette support)
- Three display modes: **Composite** (grid layout), **Animation** (frame-by-frame playback), **Button** (toggle states)
- Click-to-select, drag-and-drop frame repositioning with soft-snap to adjacent edges
- Right-click context menu: insert, delete, reorder frames
- Import PNG images as new frames with automatic palette mapping
- Properties panel with editable X/Y position and frame dimensions
- Auto-detection of animation files based on frame size and count
- GIMP integration: export as PNG (composite) or OpenRaster with layers (animation/button), import changes back

### Binary Patcher
- Patch `.dll` and `.exe` files using schema-defined hex edits
- PE format parsing for RVA-to-file-offset conversion
- Verify and revert individual patches

### Save Queue
- All changes are staged before applying
- Cell-level diffs show exactly what changed (row name, column, old/new values)
- Three-level tree view: file > row > column changes
- Publish atomically to avoid partial updates
- Automatic backups of original files before first publish

### Mod Packages
- Export your changes as a shareable JSON mod package
- Import mod packages from other modders
- Conflict detection and resolution

### Game Launcher
- Launch Diablo II directly from VS Code with configurable command-line flags

## Requirements

- **VS Code** 1.85.0 or later
- **Node.js** 18+ (for development)
- **Python 3** (optional, for native StormLib DLL support on Windows)
- **GIMP** (optional, for sprite editing integration)

### StormLib

The extension uses [StormLib](https://github.com/ladislav-zezula/StormLib) to read and write MPQ archives. On Windows, a 64-bit StormLib DLL is bundled at `wasm/StormLib_x64.dll` and accessed via a Python ctypes bridge. The extension falls back to a WASM backend or a stub if StormLib is unavailable.

## Installation

### From VSIX

1. Download the `.vsix` file from [Releases](https://github.com/bethington/d2-workshop/releases)
2. In VS Code: Extensions > `...` menu > **Install from VSIX**
3. Open a folder containing your Diablo II game files (`.mpq` files, `Game.exe`)

### From Source

```bash
git clone https://github.com/bethington/d2-workshop.git
cd d2-workshop
npm install
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

## Usage

1. Open your Diablo II installation folder as a VS Code workspace
2. The **D2 Workshop** icon appears in the activity bar
3. Expand MPQ archives in the **Game Files** tree to browse contents
4. Click a `.txt` file to open the Table Editor, or a `.dc6` file for the Sprite Viewer
5. Make your edits, then click **Queue Save**
6. Review changes in the **Save Queue** panel
7. Click **Publish** to write all changes to the MPQ archives

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `d2workshop.gimpPath` | `""` | Path to GIMP executable. Leave empty for auto-detection. |
| `d2workshop.autoDetectGimpChanges` | `false` | Auto-import when GIMP saves changes to exported sprite files. |
| `d2workshop.launchFlags` | `"-w"` | Command-line flags for launching Diablo II (e.g., `-w -nofixaspect`). |

## Project Structure

```
src/
  extension.ts           Entry point
  mpq/                   MPQ archive reading/writing via StormLib
  providers/             VS Code editors, tree views, filesystem
  dc6/                   DC6 sprite parsing, encoding, palette handling
  binary/                Binary patching and PE parsing
  mod/                   Save queue, mod packages, conflict resolution
  launch/                Game launcher
  webviews/              React-based editor UIs
schemas/                 Table and binary patch schemas
wasm/                    StormLib DLL and Python helpers
```

## Building

```bash
npm run build            # Build extension + webviews
npm run build:prod       # Production build (minified)
npm run watch            # Watch extension for changes
npm run watch:webviews   # Watch webviews for changes
npm run lint             # Run ESLint
npm run test             # Run tests
```

## License

[MIT](LICENSE)
