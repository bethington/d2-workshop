# Changelog

## 0.1.8 - 2026-03-18

### Added

- **Auto-fit column widths** — columns now size to fit their content instead of using fixed header-based widths; short code columns are narrow, long values expand up to 200px
- **Draggable column resize** — drag the right edge of any column header to manually resize; right-click header to "Reset to Auto Width"
- **File hiding** — right-click any .txt file in the Game Files tree to hide it; toggle visibility with the eye icon in the toolbar; persists via `d2workshop.hiddenFiles` setting
- **Schema-level `width` hints** — schemas can now specify a `width` (in character count) to override auto-fit for specific columns
- **Schema-level `hidden` flag** — schemas can mark engine-frozen files as hidden by default
- **Schema-level `category` field** — schemas now include a category for future grouping features

### Changed

- **374 column descriptions upgraded** — every remaining "Column read by game engine" placeholder across 13 schema files replaced with engine-verified descriptions via Ghidra reverse engineering of D2Common.dll
- **Engine-verified columns** — armor.txt, weapons.txt, misc.txt, levels.txt, setitems.txt, uniqueitems.txt, magicprefix.txt, magicsuffix.txt, automagic.txt, charstats.txt, superuniques.txt, gems.txt, runes.txt, books.txt, inventory.txt all fully investigated
- **New columns discovered** — 40 new columns added to charstats.txt (item1-10, stats), `absorbs` added to armor.txt, `QuestFlag` added to levels.txt
- **Type corrections** — fixed ~30 columns across item files (string to integer), removed incorrect refs, added missing refs to states.txt and itemstatcost.txt
- **armtype.txt** — detailed engine documentation added from Ghidra analysis of D2Common.dll Composit.cpp
- **Unique column IDs** — fixed duplicate React key warnings for files with repeated column names (e.g., mindam/maxdam in weapons.txt)

## 0.1.7 - 2026-03-17

### Added

- **Ref/enum validation system** — columns that reference other .txt files now show dropdowns or autocomplete with valid values from the referenced file
- **Multi-file refs** — columns like item codes that span armor.txt, weapons.txt, and misc.txt merge all valid options
- **Boolean format hints** — 0/1 flag columns render as toggles in the table editor and card panel
- **Integer range validation** — known bounded fields (durability, block chance, level, palette index, etc.) show min/max errors
- **Case-insensitive ref matching** — values are matched regardless of casing
- **Ref value caching** — resolved values are cached for 60 seconds to avoid redundant MPQ reads across editors
- **MCP validation enhancements** — `d2_validate_table` now checks ref/enum values, boolean format, min/max ranges, and required fields (previously only checked integer format)

### Changed

- 556 ref annotations added across 40+ schema files linking columns to their valid value sources
- 32 schema files annotated with boolean format hints for 0/1 flag columns
- 12 schema files annotated with min/max integer ranges
- Lookup table key columns (playerclass, elemtypes, bodylocs, hitclass, monmode, etc.) marked as required/unique
- Large value sets (>20 options) now use autocomplete input instead of dropdown select

## 0.1.6 - 2026-03-17

### Added

- `d2workshop.gameDirectory` setting — point at your Diablo II install folder when your workspace is not the game directory
- "Set Game Directory..." browse command — folder picker so you don't have to type paths manually
- Empty-state guidance in the Game Files tree — shows "No MPQ files found" with a clickable action to set the game directory
- Auto-refresh when `gameDirectory` setting changes — all components (tree, MPQ manager, save queue, launcher) re-point instantly

### Fixed

- Ensure `StormLib_x64.dll` and `mpq_write.py` are bundled in the published .vsix package (were missing in marketplace installs)
- Exclude dev-only `wasm/build-stormlib.sh` from published package

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
