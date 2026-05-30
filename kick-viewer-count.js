/**
 * Kick — Re-show hidden viewer count
 *
 * When a streamer enables "hide viewer count", Kick stops rendering the number
 * but the /current-viewers endpoint still returns it. This script reads that
 * value and reinjects it into the native UI slot.
 *
 * Update strategy:
 *   - Primary: a fetch hook reads the response of the page's own
 *     /current-viewers request, so the count updates exactly when Kick's does.
 *     This avoids drifting against the endpoint's 60s edge cache.
 *   - Fallback: a timer polls directly, covering the first paint before the
 *     page makes its own call and any period where it stops polling. The timer
 *     pauses while the tab is hidden.
 *
 * The script is SPA-aware (re-detects the channel on client-side navigation)
 * and releases every hook, listener, timer, observer, and in-flight request on
 * stop() or page unload.
 *
 * Usage:  paste into the DevTools console on any kick.com/<channel> page.
 * Stop:   __kickViewers.stop()       Force a refresh: __kickViewers.poll()
 */
(() => {
  'use strict';

  // Re-running tears down the prior instance first so hooks are never stacked.
  if (window.__kickViewers) {
    try { window.__kickViewers.stop(); } catch { /* nothing to clean up */ }
  }

  // ── Config ────────────────────────────────────────────────────────────────
  const CONFIG = Object.freeze({
    pollMs: 60_000, // fallback cadence; matches the endpoint's 60s edge cache
    nodeId: 'riv-wrap', // id of the injected wrapper element
    wrapClass: 'min b-h-[1.375rem] flex items-center gap-1 text-sm font-bold',
    viewersRe: /current-viewers\?ids\[\]=(\d+)/, // livestream id is group 1
    // URL slugs that are app routes, not channels. Skip id resolution on these.
    reservedSlugs: new Set([
      '', 'browse', 'categories', 'category', 'following', 'search',
      'messages', 'subscriptions', 'clips', 'dashboard', 'settings', 'help',
    ]),
  });

  // Native eye icon markup, taken from Kick so the injected element matches.
  const EYE_SVG =
    '<svg width="32" height="32" viewBox="0 0 32 32" fill="white" class="size-4">' +
      '<path d="M4 19V28H7V22H16V28H28V19H4Z"></path>' +
      '<path d="M10.75 17.5C14.4775 17.5 17.5 14.4775 17.5 10.75C17.5 7.0225 14.4775 4 10.75 4C7.0225 4 4 7.0225 4 10.75C4 14.4775 7.0225 17.5 10.75 17.5ZM10.75 7C12.82 7 14.5 8.68 14.5 10.75C14.5 12.82 12.82 14.5 10.75 14.5C8.68 14.5 7 12.82 7 10.75C7 8.68 8.68 7 10.75 7Z"></path>' +
      '<path d="M23.5 17.5C25.9853 17.5 28 15.4853 28 13C28 10.5147 25.9853 8.5 23.5 8.5C21.0147 8.5 19 10.5147 19 13C19 15.4853 21.0147 17.5 23.5 17.5Z"></path>' +
    '</svg>';

  const NUM_ID = `${CONFIG.nodeId}-num`; // inner span that holds the number

  // ── State ───────────────────────────────────────────────────────────────
  let livestreamId = null; // current channel's id, re-resolved on navigation
  let sniffedId = null; // id observed on the page's own current-viewers call
  let lastCount = null; // last rendered value; used to skip redundant writes
  let currentPath = location.pathname; // compared against to detect navigation
  let stopped = false; // set by stop(); every async path checks it
  let polling = false; // prevents overlapping poll() runs
  let rafId = 0; // pending requestAnimationFrame from the observer

  // Resources acquired at boot and released in stop().
  let intervalId = null;
  let observer = null;
  let abort = null; // aborts the in-flight fallback fetch
  let originalFetch = null;
  let originalPushState = null;
  let originalReplaceState = null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  // Channel slug from the URL, or null on reserved app routes.
  const channelSlug = () => {
    const slug = location.pathname.split('/').filter(Boolean)[0] || '';
    return CONFIG.reservedSlugs.has(slug) ? null : slug;
  };

  // Kick's own count element, present only when the streamer hasn't hidden it.
  const nativeCount = () => document.querySelector('[data-testid="viewer-count"]');

  // ── ID resolution ─────────────────────────────────────────────────────────
  // Resolve the livestream id from the channel API. Returns null when offline,
  // on a reserved route, or if the request is aborted.
  const fetchIdFromApi = async (signal) => {
    const slug = channelSlug();
    if (!slug) return null;
    try {
      const res = await originalFetch.call(window, `/api/v2/channels/${slug}`, {
        headers: { accept: 'application/json' },
        credentials: 'include',
        signal,
      });
      const data = await res.json();
      return data?.livestream?.id ?? null;
    } catch {
      return null;
    }
  };

  // Prefer the cached id, then one sniffed from the page, then a live lookup.
  const resolveId = async (signal) =>
    livestreamId || sniffedId || (await fetchIdFromApi(signal));

  // ── DOM ─────────────────────────────────────────────────────────────────
  // The action row at the bottom of the channel header that holds the Share
  // button. The native count sits as its first child, so that is where ours
  // goes too. Anchor on the count if present, otherwise walk up from Share.
  const findRow = () => {
    const native = nativeCount();
    if (native) return native.parentElement;

    const share = document.querySelector('button[aria-label="Share via"]');
    if (!share) return null;

    let el = share.parentElement;
    while (el && !el.classList.contains('self-end')) el = el.parentElement;
    return el || share.parentElement;
  };

  // Build the wrapper once. Class names mirror Kick's so layout and color match.
  const createNode = () => {
    const el = document.createElement('div');
    el.id = CONFIG.nodeId;
    el.className = CONFIG.wrapClass;
    el.innerHTML =
      EYE_SVG +
      '<span class="text-subtle relative flex items-center gap-x-1">' +
        '<span class="text-primary-base">' +
          `<span id="${NUM_ID}" class="relative tabular-nums"></span>` +
        '</span>&nbsp;watching' +
      '</span>';
    return el;
  };

  // The single render path, called by both the fetch hook and the poll. Ensures
  // the node exists, sits in the right place, and shows the given count. Defers
  // to Kick and removes our node whenever the native count is on screen.
  const applyCount = (count) => {
    if (stopped || typeof count !== 'number' || !Number.isFinite(count)) return;

    if (nativeCount()) {
      document.getElementById(CONFIG.nodeId)?.remove();
      lastCount = null;
      return;
    }

    const row = findRow();
    if (!row) return;

    let el = document.getElementById(CONFIG.nodeId);
    const isNew = !el;
    if (isNew) el = createNode();

    // Keep it as the row's first child (left of Share), matching native layout.
    if (el.parentElement !== row || row.firstChild !== el) {
      row.insertBefore(el, row.firstChild);
    }

    // Write text only when the value changed, to avoid redundant reflows.
    if (isNew || count !== lastCount) {
      el.querySelector(`#${NUM_ID}`).textContent = count.toLocaleString();
      lastCount = count;
    }
  };

  // ── fetch hook (primary update path) ──────────────────────────────────────
  // Wrap window.fetch to observe the page's own current-viewers requests. The
  // count is read from a clone of the response, leaving the original body
  // intact for Kick's code, and the id is captured for the fallback poll.
  const installFetchHook = () => {
    originalFetch = window.fetch;
    const hooked = function (...args) {
      let url = null;
      try {
        url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      } catch { /* non-string, non-Request input */ }

      const match = !stopped && url ? CONFIG.viewersRe.exec(url) : null;
      if (match) sniffedId = Number(match[1]);

      const result = originalFetch.apply(this, args);

      if (match) {
        result
          .then((res) => res.clone().json())
          .then(([data]) => { if (data && !stopped) applyCount(data.viewers); })
          .catch(() => { /* network/parse errors are non-fatal here */ });
      }
      return result;
    };
    hooked.__kickPatched = true; // lets stop() confirm the wrapper is still ours
    window.fetch = hooked;
  };

  // ── SPA navigation ──────────────────────────────────────────────────────
  // Kick routes between channels client-side, so the page never unloads and the
  // cached id would otherwise point at the previous stream. Clear per-channel
  // state and re-detect whenever the path changes.
  const onRouteChange = () => {
    if (stopped || location.pathname === currentPath) return;
    currentPath = location.pathname;

    livestreamId = null;
    sniffedId = null;
    lastCount = null;
    document.getElementById(CONFIG.nodeId)?.remove();
    poll();
  };

  // pushState/replaceState don't emit events, so wrap them; popstate covers the
  // back/forward buttons. The route check is deferred a microtask so
  // location.pathname reflects the new URL before it runs.
  const installRouteHook = () => {
    originalPushState = history.pushState;
    originalReplaceState = history.replaceState;

    const wrap = (orig) =>
      function (...args) {
        const ret = orig.apply(this, args);
        Promise.resolve().then(onRouteChange);
        return ret;
      };

    history.pushState = wrap(originalPushState);
    history.replaceState = wrap(originalReplaceState);
    window.addEventListener('popstate', onRouteChange);
  };

  // ── Poll (fallback) ───────────────────────────────────────────────────────
  // Direct fetch of the count, used for the initial paint and as a safety net.
  // Each run gets a fresh AbortController so stop() or navigation cancels any
  // request still in flight; the re-entrancy guard prevents overlapping runs.
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;

    abort?.abort();
    abort = new AbortController();
    const { signal } = abort;

    try {
      livestreamId = await resolveId(signal);
      if (!livestreamId || stopped || signal.aborted) return;

      const res = await originalFetch.call(window, `/current-viewers?ids[]=${livestreamId}`, {
        headers: { accept: 'application/json' },
        credentials: 'include',
        signal,
      });
      const [data] = await res.json();
      if (data && !stopped && !signal.aborted) applyCount(data.viewers);
    } catch (err) {
      if (err?.name !== 'AbortError') console.warn('[kick-viewers] poll failed', err);
    } finally {
      polling = false;
    }
  };

  // ── Timer (visibility-aware) ────────────────────────────────────────────
  const startTimer = () => {
    if (intervalId === null && !stopped) intervalId = setInterval(poll, CONFIG.pollMs);
  };
  const stopTimer = () => {
    if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
  };
  // Suspend the fallback timer while the tab is hidden; the fetch hook still
  // catches any update the page makes. Resume and refresh on return.
  const onVisibility = () => {
    if (stopped) return;
    if (document.hidden) {
      stopTimer();
    } else {
      startTimer();
      poll();
    }
  };

  // ── Observer (debounced) ──────────────────────────────────────────────────
  // The framework can repaint the header and drop our node. Watch for it, but
  // coalesce bursts to one check per frame so live chat's churn can't trigger a
  // flood. Re-seat from the last known count locally; only fetch if we've never
  // had a value. Remove our node if Kick's native count has reappeared.
  const onMutations = () => {
    if (stopped || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (stopped) return;
      if (nativeCount()) {
        document.getElementById(CONFIG.nodeId)?.remove();
        lastCount = null;
      } else if (!document.getElementById(CONFIG.nodeId)) {
        if (lastCount !== null) applyCount(lastCount);
        else poll();
      }
    });
  };

  // ── Teardown ──────────────────────────────────────────────────────────────
  // Reverse everything boot set up: timer, pending frame, observer, in-flight
  // request, the fetch/history wrappers, all listeners, and the DOM node.
  const stop = () => {
    if (stopped) return;
    stopped = true;

    stopTimer();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (observer) { observer.disconnect(); observer = null; }
    abort?.abort();

    // Restore wrappers only if still ours, so a later patch isn't clobbered.
    if (originalFetch && window.fetch?.__kickPatched) window.fetch = originalFetch;
    if (originalPushState) history.pushState = originalPushState;
    if (originalReplaceState) history.replaceState = originalReplaceState;

    window.removeEventListener('popstate', onRouteChange);
    window.removeEventListener('pagehide', stop);
    window.removeEventListener('beforeunload', stop);
    document.removeEventListener('visibilitychange', onVisibility);

    document.getElementById(CONFIG.nodeId)?.remove();
    delete window.__kickViewers;
    console.log('[kick-viewers] stopped, cleaned up');
  };

  // ── Boot ────────────────────────────────────────────────────────────────
  installFetchHook();
  installRouteHook();

  observer = new MutationObserver(onMutations);
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', stop); // fires on unload and bfcache evict
  window.addEventListener('beforeunload', stop);

  if (!document.hidden) startTimer();

  // Console handle for manual stop/refresh and config inspection.
  window.__kickViewers = Object.freeze({ stop, poll, config: CONFIG });

  poll(); // initial paint, before the page makes its own request
  console.log('[kick-viewers] running — call __kickViewers.stop() to remove');
})();
