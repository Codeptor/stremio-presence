// Detection by PLAYHEAD ADVANCEMENT, not mere mtime freshness. Browsing a title (opening its detail
// page) or a stale "Continue Watching" entry updates that library item's mtime — often with a small
// leftover timeOffset — but does NOT advance the playhead. So freshness alone wrongly shows browsed/
// stale titles. We only treat a title as PLAYING once we observe its timeOffset actually INCREASE,
// and we clear once it stops advancing. Stremio pushes the playhead to the cloud ~every 90s while
// watching, so staleSeconds must comfortably exceed that gap. State is tracked PER id because the
// freshest-by-mtime item can flip between the playing title and a browsed one between pushes.
export function createDetector({ staleSeconds, pausedMaxSeconds }) {
  const tracks = new Map(); // id -> { lastOffset, lastAdvanceMs }

  function classify({ id, state, nowMs }) {
    if (!id) return { status: "idle" };
    const offset = state?.timeOffset ?? 0;

    let t = tracks.get(id);
    if (!t) {
      // First time we see this id: record the position but don't show it until we witness an advance.
      tracks.set(id, { lastOffset: offset, lastAdvanceMs: 0 });
      return { status: "idle" };
    }
    if (offset > t.lastOffset) t.lastAdvanceMs = nowMs; // playhead moved forward -> actively playing
    t.lastOffset = offset;

    if (tracks.size > 64) {
      for (const [k, v] of tracks) {
        if (k !== id && nowMs - v.lastAdvanceMs > pausedMaxSeconds * 1000) tracks.delete(k);
      }
    }

    if (t.lastAdvanceMs === 0) return { status: "idle" }; // never advanced => browsing / stale entry
    const sinceAdvance = nowMs - t.lastAdvanceMs;
    if (sinceAdvance <= staleSeconds * 1000) return { status: "playing" };
    if (sinceAdvance <= pausedMaxSeconds * 1000) return { status: "paused" };
    return { status: "idle" };
  }

  function reset() {
    tracks.clear();
  }

  return { classify, reset };
}
