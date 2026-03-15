import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";

/**
 * Launches Game.exe with configurable command-line flags.
 */
export class GameLauncher {
  constructor(private readonly workspaceRoot: string) {}

  async launch(): Promise<void> {
    const gameExe = this.findGameExe();
    if (!gameExe) {
      vscode.window.showErrorMessage(
        "Game.exe not found in workspace folder."
      );
      return;
    }

    const flags =
      vscode.workspace
        .getConfiguration("d2workshop")
        .get<string>("launchFlags") || "";

    const command = `"${gameExe}" ${flags}`.trim();

    try {
      exec(command, { cwd: this.workspaceRoot });
      vscode.window.showInformationMessage(
        `Launched: ${path.basename(gameExe)} ${flags}`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to launch game: ${err}`);
    }
  }

  private findGameExe(): string | null {
    const candidates = ["Game.exe", "Diablo II.exe"];
    for (const name of candidates) {
      const fullPath = path.join(this.workspaceRoot, name);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
    return null;
  }
}
