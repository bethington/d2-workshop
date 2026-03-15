import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export interface ModProfile {
  /** Display name for the mod */
  name: string;
  /** Absolute path to the mod's root folder */
  rootPath: string;
  /** Whether this is the base game (workspace root) */
  isBase: boolean;
}

/**
 * Manages mod profiles within a Diablo II workspace.
 * Auto-detects mod folders and allows manual additions.
 * Persists the active mod selection.
 */
export class ModProfileManager {
  private profiles: ModProfile[] = [];
  private _activeProfile: ModProfile | null = null;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly workspaceRoot: string) {
    this.detectProfiles();
    this.loadActiveProfile();
  }

  get activeProfile(): ModProfile {
    if (!this._activeProfile) {
      // Default to base game
      this._activeProfile = this.profiles.find((p) => p.isBase) || this.profiles[0];
    }
    return this._activeProfile;
  }

  get activePath(): string {
    return this.activeProfile.rootPath;
  }

  getProfiles(): readonly ModProfile[] {
    return this.profiles;
  }

  async switchProfile(profile: ModProfile): Promise<void> {
    this._activeProfile = profile;
    this.saveActiveProfile();
    this._onDidChange.fire();
  }

  /**
   * Scan workspace for mod folders.
   * A mod folder is any subfolder containing Game.exe, Diablo II.exe, or .mpq files.
   */
  detectProfiles(): void {
    this.profiles = [];

    // Add base game (workspace root)
    this.profiles.push({
      name: "Base Game",
      rootPath: this.workspaceRoot,
      isBase: true,
    });

    // Scan subfolders for mod installations
    try {
      const entries = fs.readdirSync(this.workspaceRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;

        const subPath = path.join(this.workspaceRoot, entry.name);
        if (this.isModFolder(subPath)) {
          this.profiles.push({
            name: entry.name,
            rootPath: subPath,
            isBase: false,
          });
        }
      }
    } catch {
      // Workspace may not be accessible
    }

    // Load any manually added profiles
    this.loadManualProfiles();
  }

  /** Add a mod profile manually */
  addProfile(name: string, rootPath: string): void {
    if (this.profiles.some((p) => p.rootPath === rootPath)) return;
    this.profiles.push({ name, rootPath, isBase: false });
    this.saveManualProfiles();
    this._onDidChange.fire();
  }

  /** Remove a manually added profile */
  removeProfile(rootPath: string): void {
    this.profiles = this.profiles.filter(
      (p) => p.rootPath !== rootPath || p.isBase
    );
    this.saveManualProfiles();
    this._onDidChange.fire();
  }

  private isModFolder(dirPath: string): boolean {
    try {
      const files = fs.readdirSync(dirPath);
      return files.some((f) => {
        const lower = f.toLowerCase();
        return (
          lower === "game.exe" ||
          lower === "diablo ii.exe" ||
          lower.endsWith(".mpq")
        );
      });
    } catch {
      return false;
    }
  }

  private loadActiveProfile(): void {
    const config = vscode.workspace.getConfiguration("d2workshop");
    const savedPath = config.get<string>("activeModPath");
    if (savedPath) {
      this._activeProfile =
        this.profiles.find((p) => p.rootPath === savedPath) || null;
    }
  }

  private saveActiveProfile(): void {
    const config = vscode.workspace.getConfiguration("d2workshop");
    config.update(
      "activeModPath",
      this._activeProfile?.rootPath || "",
      vscode.ConfigurationTarget.Workspace
    );
  }

  private loadManualProfiles(): void {
    const configPath = path.join(
      this.workspaceRoot,
      ".d2workshop",
      "mod-profiles.json"
    );
    try {
      if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (
              entry.name &&
              entry.rootPath &&
              !this.profiles.some((p) => p.rootPath === entry.rootPath)
            ) {
              this.profiles.push({
                name: entry.name,
                rootPath: entry.rootPath,
                isBase: false,
              });
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  private saveManualProfiles(): void {
    const manual = this.profiles.filter(
      (p) => !p.isBase && !p.rootPath.startsWith(this.workspaceRoot + path.sep)
    );
    if (manual.length === 0) return;

    const configDir = path.join(this.workspaceRoot, ".d2workshop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "mod-profiles.json"),
      JSON.stringify(
        manual.map((p) => ({ name: p.name, rootPath: p.rootPath })),
        null,
        2
      )
    );
  }
}
