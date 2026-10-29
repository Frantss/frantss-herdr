import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.mjs", "mods/**/*.test.mjs"],
    environment: "node",
    execArgv: ["--experimental-vm-modules"],
  },
  fmt: {
    ignorePatterns: ["AGENTS.md"],
  },
  lint: {},
});
