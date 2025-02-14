import { defineConfig } from "vite";
import deno from "@deno/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [deno()],
  server: {
    cors: true,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8080",
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
