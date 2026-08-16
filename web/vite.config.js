import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: path.resolve(process.cwd(), "web"),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4100",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
