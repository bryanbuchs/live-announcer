# Live Announcer

Firefox WebExtension for debugging ARIA live regions by showing toast messages when region text changes.

## Current scope (v1)

- Monitors live regions in the main document only.
- Detects explicit `aria-live` and common implicit live roles (`alert`, `status`, `log`, `timer`, `marquee`).
- Shows on-page toasts for non-empty updates with duplicate suppression and short update coalescing.
- Uses level-specific toast styling (`polite` and `assertive`) and includes per-toast dismiss controls.

## Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**
3. Select this project's `manifest.json`.

## Development notes

- Entry script: `src/content/live-announcer.js`
- Toast styles: `src/content/live-announcer.css`
- No build step is required right now.
