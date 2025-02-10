import { defineConfig } from "vite";
import deno from "@deno/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [deno()],
  server: {
    allowedHosts: [
      "localhost",
      "laptop.fridgepoem.com",
    ],
    cors: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/ws": {
        target: "ws://127.0.0.1:8080",
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
