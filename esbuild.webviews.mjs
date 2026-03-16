import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const webviewEntryPoints = [
  "src/webviews/table-editor/index.tsx",
  "src/webviews/dc6-viewer/index.tsx",
  "src/webviews/binary-editor/index.tsx",
  "src/webviews/mod-manager/index.tsx",
  "src/webviews/cof-viewer/index.tsx",
  "src/webviews/dt1-viewer/index.tsx",
  "src/webviews/pl2-viewer/index.tsx",
];

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: webviewEntryPoints,
  bundle: true,
  format: "esm",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  outdir: "dist/webviews",
  tsconfig: "tsconfig.webviews.json",
  logLevel: "info",
  splitting: true,
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(webviewConfig);
    await ctx.watch();
    console.log("[webviews] watching for changes...");
  } else {
    await esbuild.build(webviewConfig);
    console.log("[webviews] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
