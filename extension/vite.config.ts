import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync, mkdirSync, existsSync, renameSync } from "fs";

/**
 * Post-build: copies manifest.json + icons into dist/,
 * and moves popup HTML from dist/src/popup/ to dist/popup/.
 */
function chromeExtensionPlugin(): Plugin {
  return {
    name: "chrome-extension",
    closeBundle() {
      const dist = resolve(__dirname, "dist");

      // Copy manifest.json
      copyFileSync(resolve(__dirname, "manifest.json"), resolve(dist, "manifest.json"));

      // Move popup HTML to where manifest expects it: popup/index.html
      // Also fix the script src to be relative from popup/ to dist root
      const builtPopup = resolve(dist, "src", "popup", "index.html");
      const targetDir = resolve(dist, "popup");
      if (existsSync(builtPopup)) {
        mkdirSync(targetDir, { recursive: true });
        const { readFileSync, writeFileSync, rmSync } = require("fs");
        let html = readFileSync(builtPopup, "utf-8");
        // Fix relative path: from popup/ we need ../popup.js
        html = html.replace(/src="[^"]*popup\.js"/, 'src="../popup.js"');
        writeFileSync(resolve(targetDir, "index.html"), html);
        // Clean up the leftover src/ directory
        rmSync(resolve(dist, "src"), { recursive: true, force: true });
      }

      // Copy icons if they exist
      const iconSrc = resolve(__dirname, "assets");
      const iconDst = resolve(dist, "assets");
      if (existsSync(iconSrc)) {
        mkdirSync(iconDst, { recursive: true });
        for (const icon of ["icon16.png", "icon48.png", "icon128.png"]) {
          const src = resolve(iconSrc, icon);
          if (existsSync(src)) copyFileSync(src, resolve(iconDst, icon));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), chromeExtensionPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Chrome extension needs relative paths, not absolute
    assetsDir: "assets",
    rollupOptions: {
      input: {
        content: resolve(__dirname, "src/content/index.ts"),
        "transcript-extractor": resolve(__dirname, "src/content/transcript-extractor.ts"),
        background: resolve(__dirname, "src/background/index.ts"),
        popup: resolve(__dirname, "src/popup/index.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  // CRITICAL: Chrome extensions load via file:// — must use relative paths
  base: "",
});
