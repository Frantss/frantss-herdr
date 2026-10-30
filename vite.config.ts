import { defineConfig } from "vite-plus";
import { appHome, outputRoot, packageRoot } from "./scripts/paths.ts";
import { pruneOutput } from "./scripts/prune.ts";
import { refreshInstall } from "./scripts/watch.ts";

export default defineConfig({
  pack: {
    entry: ["mods/*/main.ts"],
    root: ".",
    outDir: "dist",
    format: "esm",
    target: "es2022",
    platform: "neutral",
    unbundle: true,
    clean: false,
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    deps: { neverBundle: true },
    inputOptions: {
      external: ["gpui-kit", "gpui-base", "gpui-shell", "herdr"],
      // Keeps a mod's linked shared/ file inside that mod's output folder.
      resolve: { symlinks: false },
    },
    copy: [
      "layouts",
      "themes",
      {
        from: ["mods/**/mod.json", "mods/**/*.svg", "mods/**/*.png"],
        to: "dist/mods",
        flatten: false,
      },
      {
        from: "node_modules/material-icon-theme/icons/*.svg",
        to: "dist/mods/frantss-files/icons",
      },
      {
        from: "node_modules/material-icon-theme/dist/material-icons.json",
        to: "dist/mods/frantss-files",
      },
    ],
    onSuccess: () => {
      pruneOutput(outputRoot, packageRoot);
      refreshInstall(outputRoot, appHome);
    },
  },
  test: {
    include: ["scripts/**/*.test.ts", "mods/**/*.test.ts", "shared/**/*.test.ts"],
    environment: "node",
    execArgv: ["--experimental-vm-modules"],
  },
  fmt: { ignorePatterns: ["AGENTS.md"] },
  lint: {
    options: { typeAware: true, typeCheck: true },
    rules: { "typescript/no-useless-default-assignment": "off" },
  },
});
