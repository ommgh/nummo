import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on 8787; the dashboard's JSON and the checkout pages are proxied to it.
const api = process.env.NUMMO_API_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: 5173,
    proxy: { "/dashboard/api": api, "/api/auth": api, "/checkout": api, "/portal": api, "/v1": api, "/p": api },
  },
});
