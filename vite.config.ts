import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import electronRenderer from "vite-plugin-electron-renderer";
import path from "path";
import { rmSync } from "fs";

const NODE_BUILTINS = [
  "electron",
  "path",
  "fs",
  "os",
  "stream",
  "util",
  "events",
  "crypto",
  "child_process",
  "http",
  "https",
  "url",
  "net",
  "tty",
];

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: "electron/main.ts",
        onstart(args) {
          if (process.env.VITE_DEV_SERVER_URL) {
            args.startup();
          }
        },
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: NODE_BUILTINS,
            },
          },
        },
      },
      {
        entry: "electron/preload.ts",
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: NODE_BUILTINS,
            },
          },
        },
      },
    ]),
    electronRenderer(),
    {
      name: "clear-electron-dist",
      buildStart() {
        rmSync("dist-electron", { recursive: true, force: true });
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  css: {
    postcss: "./postcss.config.mjs",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});