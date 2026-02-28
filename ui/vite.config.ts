import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const sharedPath = path.resolve(__dirname, "../src");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@ticket/shared": sharedPath,
      },
    },
    server: {
      port: env.VITE_PORT ? parseInt(env.VITE_PORT) : 5173,
      fs: {
        allow: [sharedPath, __dirname],
      },
    },
  };
});
