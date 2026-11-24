import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("backends", "routes/backends.tsx"),
  route("backends/:id", "routes/backend.tsx"),
  route("contribute", "routes/contribute.tsx"),
  route("method", "routes/method.tsx"),
] satisfies RouteConfig;
