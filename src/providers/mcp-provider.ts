import * as vscode from "vscode";
import * as path from "path";

export class D2McpProvider implements vscode.McpServerDefinitionProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

  private extensionPath: string;
  private workspaceRoot: string;

  constructor(extensionPath: string, workspaceRoot: string) {
    this.extensionPath = extensionPath;
    this.workspaceRoot = workspaceRoot;
  }

  updateWorkspaceRoot(newRoot: string): void {
    this.workspaceRoot = newRoot;
    this._onDidChange.fire();
  }

  provideMcpServerDefinitions(): vscode.McpStdioServerDefinition[] {
    const serverScript = path.join(this.extensionPath, "dist", "mcp-server.js");
    const schemasDir = path.join(this.extensionPath, "schemas", "txt");
    const workspaceSchemasDir = path.join(
      this.workspaceRoot,
      ".d2workshop",
      "schemas",
      "txt"
    );

    return [
      new vscode.McpStdioServerDefinition("d2-workshop", process.execPath, [
        serverScript,
      ], {
        D2_WORKSPACE_ROOT: this.workspaceRoot,
        D2_SCHEMAS_DIR: schemasDir,
        D2_WORKSPACE_SCHEMAS_DIR: workspaceSchemasDir,
      }),
    ];
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
