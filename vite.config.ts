import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), !process.env.VITEST && reactRouter(), tsconfigPaths()],
  server: {
    host: "127.0.0.1",
    // Honor PORT when it is set; otherwise Vite picks its default.
    ...(process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : {}),
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./app/test/setup.ts"],
    exclude: ["**/node_modules/**", "build/**"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["app/**/*.test.ts", "scripts/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "component",
          environment: "jsdom",
          include: ["app/**/*.component.test.tsx"],
        },
      },
    ],
  },
});
