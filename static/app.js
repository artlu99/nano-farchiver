(() => {
  const RUN_KEY = "nano-farchiver:run:startedAt";
  const FAST_POLL_MS = 1_000;
  const SLOW_POLL_MS = 10_000;
  const RUN_MAX_MS = 60_000;

  const key = "nano-farchiver:status:all";
  const outstandingEl = document.getElementById("outstanding-all");
  const completedEl = document.getElementById("completed-all");
  if (!outstandingEl || !completedEl) return;

  const ttlMs = 30_000;

  function render(data) {
    if (!data || typeof data !== "object") return;
    if (typeof data.outstanding === "number") outstandingEl.textContent = String(data.outstanding);
    if (typeof data.completed === "number") completedEl.textContent = String(data.completed);
  }

  let cached;
  try {
    cached = JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    cached = null;
  }
  if (cached?.data) render(cached.data);

  function getRunStartedAt() {
    const raw = sessionStorage.getItem(RUN_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function clearRunState() {
    sessionStorage.removeItem(RUN_KEY);
  }

  function isFastPollActive() {
    const startedAt = getRunStartedAt();
    if (!startedAt) return false;
    return Date.now() - startedAt <= RUN_MAX_MS;
  }

  function setRunButtonState() {
    const btn = document.getElementById("run-all");
    if (!btn) return;
    if (isFastPollActive()) {
      btn.disabled = true;
      btn.textContent = "Running…";
      return;
    }
    btn.disabled = false;
    btn.textContent = "Run";
  }

  async function refresh() {
    const headers = {};
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    try {
      const res = await fetch("/status", { headers });
      if (res.status === 304) {
        // Even if data is unchanged, we still want the 60s timebox to release the UI.
        if (!isFastPollActive()) {
          clearRunState();
          setRunButtonState();
        }
        return;
      }
      if (!res.ok) return;
      const etag = res.headers.get("etag") || "";
      const data = await res.json();
      render(data);
      cached = { etag, fetchedAt: Date.now(), data };
      try {
        localStorage.setItem(key, JSON.stringify(cached));
      } catch {}

      // Stop fast polling when done (or timeboxed).
      if (typeof data?.outstanding === "number" && data.outstanding === 0) {
        clearRunState();
        setRunButtonState();
      } else if (!isFastPollActive()) {
        // timeboxed run elapsed
        clearRunState();
        setRunButtonState();
      }
    } catch {}
  }

  function scheduleNextPoll() {
    const ms = isFastPollActive() ? FAST_POLL_MS : SLOW_POLL_MS;
    setTimeout(async () => {
      await refresh();
      scheduleNextPoll();
    }, ms);
  }

  // Run button: POST /clear, wait, POST /doIt, wait, reload.
  const btn = document.getElementById("run-all");
  if (btn) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = "Running…";
      try {
        sessionStorage.setItem(RUN_KEY, String(Date.now()));
        await fetch("/clear", { method: "POST" });
        await sleep(300);
        await fetch("/doIt", { method: "POST" });
        await sleep(300);
        location.reload();
      } catch {
        btn.disabled = false;
        btn.textContent = originalText || "Run";
      }
    });
  }

  // Initial hydration + revalidate (stale-while-revalidate) then dynamic polling loop.
  setRunButtonState();
  const now = Date.now();
  const age =
    cached && typeof cached.fetchedAt === "number" ? now - cached.fetchedAt : Infinity;
  if (age > ttlMs) refresh();
  scheduleNextPoll();
})();

