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

async function main() {
  if (watch) {
    const ctx = await esbuild.context(extensionConfig);
    await ctx.watch();
    console.log("[extension] watching for changes...");
  } else {
    await esbuild.build(extensionConfig);
    console.log("[extension] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
