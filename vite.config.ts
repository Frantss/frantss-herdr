import { defineConfig } from "vite-plus";
import { appHome, outputRoot } from "./scripts/paths.ts";
import { refreshLinks } from "./scripts/watch.ts";

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
    inputOptions: { external: ["gpui-kit", "gpui-base", "gpui-shell", "herdr"] },
    copy: [
      "layouts",
      "themes",
      {
        from: ["mods/**/mod.json", "mods/**/*.svg", "mods/**/*.png"],
        to: "dist/mods",
        flatten: false,
      },
    ],
    onSuccess: () => {
      refreshLinks(outputRoot, appHome);
    },
  },
  test: {
    include: ["scripts/**/*.test.ts", "mods/**/*.test.ts"],
    environment: "node",
    execArgv: ["--experimental-vm-modules"],
  },
  fmt: { ignorePatterns: ["AGENTS.md"] },
  lint: {
    options: { typeAware: true, typeCheck: true },
    rules: { "typescript/no-useless-default-assignment": "off" },
  },
});
