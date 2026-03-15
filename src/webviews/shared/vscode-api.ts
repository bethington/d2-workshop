/**
 * Type-safe wrapper for the VS Code webview API.
 */

interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeAPI;

let api: VSCodeAPI | undefined;

export function getVSCodeAPI(): VSCodeAPI {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}

/**
 * Send a message to the extension host.
 */
export function postMessage(message: Record<string, unknown>): void {
  getVSCodeAPI().postMessage(message);
}

/**
 * Listen for messages from the extension host.
 */
export function onMessage(
  handler: (message: Record<string, unknown>) => void
): () => void {
  const listener = (event: MessageEvent) => {
    handler(event.data);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
