# Copilot Instructions

## Build, test, and lint commands

No automated build, test, or lint commands are configured yet.

- There is no `package.json`, `Makefile`, or other task runner in this repo.
- There is currently no single-test command because no test suite is set up.
- Current validation flow is manual: load `manifest.json` as a temporary Firefox add-on from `about:debugging#/runtime/this-firefox`.

## High-level architecture

This project is a Firefox-first Manifest V3 extension with no background script.

- `manifest.json` injects `src/content/live-announcer.js` and `src/content/live-announcer.css` on `<all_urls>` at `document_idle`.
- `src/content/live-announcer.js` is the core runtime:
  - discovers live regions via `[aria-live]` and implicit-live roles (`alert`, `status`, `log`, `timer`, `marquee`),
  - tracks dynamic DOM changes with one `MutationObserver`,
  - filters announcement noise (empty text, `off`, duplicate text per region),
  - renders transient on-page toasts with politeness metadata (`polite`/`assertive`).
- Scope is intentionally limited to the main document (no Shadow DOM/iframe traversal in v1).

## Key conventions

- Keep runtime code in vanilla JavaScript and CSS (no build step currently).
- Treat `src/content/live-announcer.js` as the single source of truth for live-region detection and announcement filtering.
- Use `live-announcer-` prefixed CSS classes for injected UI elements.
- Preserve current filtering behavior when changing observer logic:
  - normalize whitespace before comparison,
  - suppress empty announcements,
  - suppress repeated identical text for the same region.
- Keep Firefox compatibility settings in `manifest.json` under `browser_specific_settings.gecko`.
