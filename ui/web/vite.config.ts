import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: `npm run dev` proxies /api to a local `npm start` (port 4000).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:4000" } },
});
