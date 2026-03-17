# Changelog

## 0.1.5 - 2026-03-17

### Added

- Path picker commands for GIMP executable, game executable, and mod folders — no more manual path typing
- "Browse..." option in the Switch Mod quick pick to add mod folders inline
- Game launcher prompts with a "Browse..." button when the executable is not found
- New settings:
  - `d2workshop.gameExePath` — explicit path to Game.exe / Diablo II.exe (falls back to auto-detection)
  - `d2workshop.autoBackup` — toggle automatic backups before publishing (default: on)
  - `d2workshop.autoDeleteBin` — toggle auto-deletion of .bin files when publishing .txt changes (default: on)

## 0.1.4 - 2026-03-17

### Fixed

- Fix MCP server provider missing label in package.json

## 0.1.3 - 2026-03-17

### Fixed

- Fix extension activation failure on newer VS Code versions by declaring MCP server definition provider in package.json `contributes.mcpServerDefinitionProviders`

## 0.1.2 - 2026-03-17

### Fixed

- Fix extension views showing "There is no data provider registered" when installed from the marketplace by adding `onView` activation events

## 0.1.0 - 2026-03-17

Initial release.

### Features

- **MPQ Archive Browser** — Browse and search MPQ archive contents in a tree view with virtual `d2mpq://` filesystem
- **Table Editor** — Spreadsheet-style editor for `.txt` data tables with schema-aware column descriptions and validation
- **DC6 Sprite Viewer** — View DC6/DCC sprites with palette rendering, animation playback, drag-and-drop frame editing, and GIMP integration
- **DT1 Tile Viewer** — View DT1 tile graphics
- **PL2 Palette Viewer** — View and inspect PL2 palette files
- **COF Viewer** — View COF animation component files
- **Binary Patcher** — Patch DLLs and EXEs using schema-defined hex edits with PE format support
- **Save Queue** — Stage all changes before applying, with cell-level diffs and atomic publish
- **Mod Packages** — Export and import shareable JSON mod packages with conflict detection
- **Game Launcher** — Launch Diablo II directly from VS Code with configurable flags
- **MCP Server** — Model Context Protocol server for AI-assisted data file editing
