import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "dist/extension.js",
  external: ["vscode"],
  logLevel: "info",
  tsconfig: "tsconfig.json",
};

/** @type {esbuild.BuildOptions} */
const mcpServerConfig = {
  entryPoints: ["src/mcp/server.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "dist/mcp-server.js",
  external: ["vscode"],
  logLevel: "info",
  tsconfig: "tsconfig.json",
};

async function main() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const mcpCtx = await esbuild.context(mcpServerConfig);
    await extCtx.watch();
    await mcpCtx.watch();
    console.log("[extension+mcp] watching for changes...");
  } else {
    await esbuild.build(extensionConfig);
    console.log("[extension] build complete");
    await esbuild.build(mcpServerConfig);
    console.log("[mcp-server] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
