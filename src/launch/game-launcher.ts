import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";

/**
 * Launches Game.exe with configurable command-line flags.
 */
export class GameLauncher {
  constructor(private workspaceRoot: string) {}

  setRoot(newRoot: string): void {
    this.workspaceRoot = newRoot;
  }

  async launch(): Promise<void> {
    const gameExe = this.findGameExe();
    if (!gameExe) {
      const browse = "Browse...";
      const choice = await vscode.window.showErrorMessage(
        "Game executable not found. Set the path manually.",
        browse
      );
      if (choice === browse) {
        await vscode.commands.executeCommand("d2workshop.browseGameExe");
      }
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
    // Check user-configured path first
    const configured = vscode.workspace
      .getConfiguration("d2workshop")
      .get<string>("gameExePath");
    if (configured && fs.existsSync(configured)) {
      return configured;
    }

    // Auto-detect from workspace
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
