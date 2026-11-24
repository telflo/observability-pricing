import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";
import { SiteFooter } from "~/components/SiteFooter";
import { SiteHeader } from "~/components/SiteHeader";
import { container, textLink } from "~/components/ui";
import { themeInitScript } from "~/theme";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // The script below may add data-theme before React starts, so the tag can differ from the built page.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <Meta />
        <Links />
      </head>
      <body>
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/** Shown for the moment before a page that was not rendered ahead of time loads. */
export function HydrateFallback() {
  return <div className="min-h-[70vh]" />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <section className="py-28">
      <div className={container}>
        <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
          {missing ? "There is no page here" : "Something went wrong"}
        </h1>
        <p className="mt-3 max-w-xl text-[16px] leading-relaxed text-ink-2">
          {missing
            ? "The address may be mistyped, or the page may have moved."
            : "The page could not be shown. Reloading usually fixes it."}{" "}
          <a href="/" className={textLink}>
            Go to the calculator
          </a>
        </p>
      </div>
    </section>
  );
}
