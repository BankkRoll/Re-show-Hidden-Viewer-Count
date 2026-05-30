/**
 * Kick — Re-show hidden viewer count
 *
 * Reinjects the real viewer count (from /current-viewers) into its native UI
 * slot when a streamer has hidden it. Auto-detects the channel and livestream
 * ID, matches Kick's own markup, and survives framework re-renders.
 *
 * Usage: paste into DevTools console on any kick.com/<channel> page.
 */
(async () => {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────
  const CONFIG = {
    pollMs: 60_000, // fallback poll; primary updates ride Kick's own request (see below)
    nodeId: 'riv-wrap', // id of our injected wrapper
    wrapClass: 'min b-h-[1.375rem] flex items-center gap-1 text-sm font-bold',
  };

  // Native eye icon, copied from Kick so spacing/color match exactly.
  const EYE_SVG =
    '<svg width="32" height="32" viewBox="0 0 32 32" fill="white" class="size-4">' +
      '<path d="M4 19V28H7V22H16V28H28V19H4Z"></path>' +
      '<path d="M10.75 17.5C14.4775 17.5 17.5 14.4775 17.5 10.75C17.5 7.0225 14.4775 4 10.75 4C7.0225 4 4 7.0225 4 10.75C4 14.4775 7.0225 17.5 10.75 17.5ZM10.75 7C12.82 7 14.5 8.68 14.5 10.75C14.5 12.82 12.82 14.5 10.75 14.5C8.68 14.5 7 12.82 7 10.75C7 8.68 8.68 7 10.75 7Z"></path>' +
      '<path d="M23.5 17.5C25.9853 17.5 28 15.4853 28 13C28 10.5147 25.9853 8.5 23.5 8.5C21.0147 8.5 19 10.5147 19 13C19 15.4853 21.0147 17.5 23.5 17.5Z"></path>' +
    '</svg>';

  // ── State ───────────────────────────────────────────────────────────────
  let livestreamId = null; // resolved lazily, re-checked each poll
  let sniffedId = null; // backup id, captured from the page's own requests

  // ── ID resolution ─────────────────────────────────────────────────────────
  /** Resolve the livestream id from the channel API (slug taken from the URL). */
  const fetchIdFromApi = async () => {
    const slug = location.pathname.split('/').filter(Boolean)[0];
    if (!slug) return null;
    try {
      const res = await fetch(`/api/v2/channels/${slug}`, {
        headers: { accept: 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      return data?.livestream?.id ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Wrap fetch to piggyback on the page's own current-viewers calls.
   * This is the primary update path: we render the moment Kick gets fresh data,
   * so we stay perfectly in sync with the cache instead of drifting against it.
   * We also capture the id here as a fallback for the standalone poll.
   */
  const installIdSniffer = () => {
    const original = window.fetch;
    window.fetch = async function (...args) {
      const url = (() => {
        try {
          return typeof args[0] === 'string' ? args[0] : args[0]?.url;
        } catch {
          return null;
        }
      })();

      const isViewers = url && /current-viewers\?ids\[\]=(\d+)/.test(url);
      if (isViewers) sniffedId = Number(url.match(/ids\[\]=(\d+)/)[1]);

      const res = await original.apply(this, args);

      // Read the count straight from the page's own response (clone to not consume it).
      if (isViewers) {
        res
          .clone()
          .json()
          .then(([data]) => {
            if (data) render(data.viewers);
          })
          .catch(() => {});
      }

      return res;
    };
  };

  /** Best-effort id, preferring a freshly sniffed one, then the API. */
  const resolveId = async () =>
    livestreamId || sniffedId || (await fetchIdFromApi());

  // ── DOM ─────────────────────────────────────────────────────────────────
  /** The bottom action row that holds the Share button (native count's parent). */
  const findRow = () => {
    const native = document.querySelector('[data-testid="viewer-count"]');
    if (native) return native.parentElement;

    const share = document.querySelector('button[aria-label="Share via"]');
    if (!share) return null;

    let el = share.parentElement;
    while (el && !el.classList.contains('self-end')) el = el.parentElement;
    return el || share.parentElement;
  };

  /** Build our count node (once). */
  const createNode = () => {
    const el = document.createElement('div');
    el.id = CONFIG.nodeId;
    el.className = CONFIG.wrapClass;
    el.innerHTML =
      EYE_SVG +
      '<span class="text-subtle relative flex items-center gap-x-1">' +
        '<span class="text-primary-base">' +
          `<span id="${CONFIG.nodeId}-num" class="relative tabular-nums"></span>` +
        '</span>&nbsp;watching' +
      '</span>';
    return el;
  };

  /** Inject/update our count, or defer to Kick if it's showing its own. */
  const render = (count) => {
    // Native count is visible — remove our copy and let Kick own it.
    if (document.querySelector('[data-testid="viewer-count"]')) {
      document.getElementById(CONFIG.nodeId)?.remove();
      return;
    }

    const row = findRow();
    if (!row) return;

    let el = document.getElementById(CONFIG.nodeId);
    if (!el) el = createNode();

    // Always re-seat as the row's first child (left of Share), matching native.
    if (el.parentElement !== row || row.firstChild !== el) {
      row.insertBefore(el, row.firstChild);
    }

    el.querySelector(`#${CONFIG.nodeId}-num`).textContent = count.toLocaleString();
  };

  // ── Poll (fallback) ───────────────────────────────────────────────────────
  // Primary updates come from installIdSniffer (we ride Kick's own request).
  // This standalone poll only covers the gap before the page makes its first
  // call, and keeps the count alive if the page ever stops polling.
  const poll = async () => {
    livestreamId = await resolveId();
    if (!livestreamId) return;

    try {
      const res = await fetch(`/current-viewers?ids[]=${livestreamId}`, {
        headers: { accept: 'application/json' },
        credentials: 'include',
      });
      const [data] = await res.json();
      if (!data) return;

      render(data.viewers);
      console.log(
        `[viewers] ${data.viewers}  show_view_count=${data.show_view_count}  id=${livestreamId}`
      );
    } catch (err) {
      console.warn('[viewers] poll failed', err);
    }
  };

  // ── Boot ────────────────────────────────────────────────────────────────
  installIdSniffer(); // primary: update in lockstep with Kick's own requests
  await poll(); // show something immediately on paste
  setInterval(poll, CONFIG.pollMs); // safety net if the page goes quiet

  // Re-seat if Kick's framework repaints the row and drops our node.
  new MutationObserver(() => {
    const ours = document.getElementById(CONFIG.nodeId);
    const native = document.querySelector('[data-testid="viewer-count"]');
    if (!ours && !native) poll();
  }).observe(document.body, { childList: true, subtree: true });
})();
