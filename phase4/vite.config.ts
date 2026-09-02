import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative base: the same dist serves from "/" (nginx kiosk) and from
  // "/downlink/" (GitHub Pages project site). No per-target rebuild.
  base: "./",
  plugins: [react()],
  server: {
    host: "0.0.0.0", port: 5173,
    proxy: { "/api": { target: "http://localhost:8081", rewrite: (path) => path.slice(4) } },
  },
  build: { target: "es2022" },
});
