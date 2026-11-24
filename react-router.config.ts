import { readdirSync } from "node:fs";
import type { Config } from "@react-router/dev/config";

/**
 * The site is plain static files: every page is rendered to HTML at build
 * time, so it can be hosted anywhere and a pull request can be previewed
 * without a server.
 */
export default {
  ssr: false,
  prerender() {
    // One page per backend: every adapter file in app/pricing/vendors is one.
    const backends = readdirSync("app/pricing/vendors")
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.replace(/\.ts$/, ""))
      .filter((name) => name !== "index" && name !== "adapter-contract");
    return ["/", "/backends", "/contribute", "/method", ...backends.map((id) => `/backends/${id}`)];
  },
} satisfies Config;
