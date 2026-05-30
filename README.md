# Kick — Re-show Hidden Viewer Count

A tiny console script that re-displays a Kick stream's real viewer count when the
streamer has chosen to hide it.

## How it works

Kick recently added a streamer toggle to hide the viewer count. When it's enabled,
the number disappears from the UI, but the underlying API still returns it:

```
GET https://kick.com/current-viewers?ids[]=<livestream_id>

[{"livestream_id":110825343,"viewers":1567,"show_view_count":false}]
```

The frontend simply chooses not to render `viewers` when `show_view_count` is
`false`. This script polls that endpoint and injects the count back into its
native spot in the page (left of the Share button), styled to match Kick's own
element.

It is read-only: it does nothing but `GET` a public aggregate number that the
page already requests. No private data, no account access.

## Usage

1. Open any `kick.com/<channel>` page.
2. Open DevTools (`F12`) and go to the **Console** tab.
3. Paste the contents of [`kick-viewer-count.js`](./kick-viewer-count.js) and press Enter.

The count appears in the action row and refreshes automatically. Reload the page
to remove it.

## Features

- **Auto-detects the channel** from the URL slug.
- **Resolves the livestream ID** via `/api/v2/channels/<slug>`, with a fallback
  that sniffs the page's own `current-viewers` request.
- **Matches the native markup** (same wrapper classes, eye icon, and "watching"
  label) so it looks like Kick's own element.
- **Survives re-renders** via a `MutationObserver` that re-seats the node if the
  framework repaints the row.
- **Defers to Kick** automatically if the native count is visible (no duplicate).

## Configuration

Tunables live in the `CONFIG` block at the top of the script:

| Key         | Default                                            | Notes |
|-------------|----------------------------------------------------|-------|
| `pollMs`    | `60_000`                                           | Poll interval in ms. |
| `nodeId`    | `'riv-wrap'`                                       | ID of the injected element. |
| `wrapClass` | `min b-h-[1.375rem] flex items-center gap-1 ...`   | Wrapper classes, copied from Kick. |

### About the 60s interval

The endpoint is served behind Cloudflare with `cache-control: public, max-age=60`,
so the number only refreshes once per minute at the edge. Polling faster just
re-reads the same cached value. 60s matches the cache TTL exactly.

## Notes

- The script uses your existing session (`credentials: 'include'`); no token to paste.
- It only reads a public aggregate viewer count, the same request the site makes.
- For personal/educational use.

## License

MIT
