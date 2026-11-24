import "@testing-library/jest-dom/vitest";

// Node 25 has a built-in localStorage. Started without --localstorage-file,
// it has no working methods, and it hides jsdom's. Put jsdom's back so the
// component tests behave the same on every Node version.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom && typeof globalThis.localStorage?.setItem !== "function") {
  Object.defineProperty(globalThis, "localStorage", {
    value: dom.window.localStorage,
    configurable: true,
  });
}
