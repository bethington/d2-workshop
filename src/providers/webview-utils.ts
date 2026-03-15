import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Generate HTML content for a webview panel.
 * Loads the bundled React app for the specified webview type.
 */
export function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  webviewType: string
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "dist",
      "webviews",
      webviewType,
      "index.js"
    )
  );

  // Check if a CSS file exists for this webview type
  const cssPath = path.join(
    extensionUri.fsPath,
    "dist",
    "webviews",
    webviewType,
    "index.css"
  );
  const hasCss = fs.existsSync(cssPath);
  const cssUri = hasCss
    ? webview.asWebviewUri(
        vscode.Uri.joinPath(
          extensionUri,
          "dist",
          "webviews",
          webviewType,
          "index.css"
        )
      )
    : null;

  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      img-src ${webview.cspSource} data: blob:;
      script-src 'nonce-${nonce}';
      style-src ${webview.cspSource} 'unsafe-inline';
      font-src ${webview.cspSource};">
  <title>D2 Workshop</title>
  ${cssUri ? `<link rel="stylesheet" href="${cssUri}">` : ""}
  <style>
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #root {
      width: 100vw;
      height: 100vh;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
