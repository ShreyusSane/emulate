import { defineConfig } from "tsup";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const copyFonts = async () => {
  const src = resolve(__dirname, "../core/src/fonts");
  const dest = resolve(__dirname, "dist/fonts");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
};

// Linear's GraphQL schema is read at runtime from next to the bundle.
const copyAssets = async () => {
  await copyFonts();
  cpSync(resolve(__dirname, "src/linear.graphql"), resolve(__dirname, "dist/linear.graphql"));
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  noExternal: [/^@emulators\/core/],
  onSuccess: copyAssets,
});
