# Live Announcer

Firefox WebExtension for debugging ARIA live regions by showing toast messages when region text changes.

## Current scope (v1)

- Monitors live regions in the main document only.
- Detects explicit `aria-live` and common implicit live roles (`alert`, `status`, `log`, `timer`, `marquee`).
- Shows on-page toasts for non-empty updates with duplicate suppression and short update coalescing.
- Uses level-specific toast styling (`polite` and `assertive`) and includes per-toast dismiss controls.
- Includes a toolbar toggle with per-domain persistence (keyed by exact hostname).

## Enable for a domain

- Default state is off for every hostname until you enable it.
- Use the extension toolbar icon to toggle the current hostname on/off.
- The icon switches between disabled/enabled artwork and remembers your choice for that hostname.
- Subdomains are independent (`app.example.com` and `www.example.com` are separate settings).

## Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**
3. Select this project's `manifest.json`.
4. Open an `http` or `https` page and click the toolbar icon to enable announcements for that hostname.

## Development notes

- Entry script: `src/content/live-announcer.js`
- Toast styles: `src/content/live-announcer.css`
- No build step is required right now.
