(() => {
	const key = "nano-farchiver:status:all";
	const outstandingEl = document.getElementById("outstanding-all");
	const completedEl = document.getElementById("completed-all");
	if (!outstandingEl || !completedEl) return;

	const ttlMs = 30_000;

	function render(data) {
		if (!data || typeof data !== "object") return;
		if (typeof data.outstanding === "number")
			outstandingEl.textContent = String(data.outstanding);
		if (typeof data.completed === "number")
			completedEl.textContent = String(data.completed);
	}

	let cached;
	try {
		cached = JSON.parse(localStorage.getItem(key) || "null");
	} catch {
		cached = null;
	}
	if (cached?.data) render(cached.data);

	async function refresh() {
		const headers = {};
		if (cached?.etag) headers["If-None-Match"] = cached.etag;
		try {
			const res = await fetch("/status", { headers });
			if (res.status === 304) return;
			if (!res.ok) return;
			const etag = res.headers.get("etag") || "";
			const data = await res.json();
			render(data);
			cached = { etag, fetchedAt: Date.now(), data };
			try {
				localStorage.setItem(key, JSON.stringify(cached));
			} catch {}
		} catch {}
	}

	function scheduleNextPoll() {
		const ms = 10_000;
		setTimeout(async () => {
			await refresh();
			scheduleNextPoll();
		}, ms);
	}

	// Run button: POST /doIt (web worker forwards to the archiver worker,
	// which sets the run-request marker in R2; the server poller executes it
	// within a minute), then reload so /status reflects the run.
	const btn = document.getElementById("run-all");
	if (btn) {
		btn.addEventListener("click", async () => {
			if (btn.disabled) return;
			btn.disabled = true;
			btn.textContent = "Queued…";
			try {
				await fetch("/doIt", { method: "POST" });
			} catch {}
			setTimeout(() => location.reload(), 1500);
		});
	}

	// Archiver run status: poll /runs/status (the progress object the server
	// poller writes to R2) and render the live row.
	const runEls = {
		state: document.getElementById("run-state"),
		phase: document.getElementById("run-phase"),
		started: document.getElementById("run-started"),
		updated: document.getElementById("run-updated"),
		unknown: document.getElementById("run-unknown"),
		hydrated: document.getElementById("run-hydrated"),
		renders: document.getElementById("run-renders"),
		scanned: document.getElementById("run-scanned"),
		failures: document.getElementById("run-failures"),
		lastline: document.getElementById("run-lastline"),
	};
	const hasRunRow = Object.values(runEls).every(Boolean);
	const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : "—");

	function renderRun(p) {
		if (!p || typeof p !== "object") return;
		// tick budget is 8 min — a running flag older than 10 min means the
		// writer died mid-run (crash/reboot); show stale instead of running
		const STALE_MS = 10 * 60 * 1000;
		const stale =
			p.running === true &&
			(!p.updatedAt || Date.now() - p.updatedAt > STALE_MS);
		runEls.state.textContent =
			p.running === true
				? stale
					? "stale"
					: "running"
				: p.completedAt
					? "finished"
					: "idle";
		runEls.phase.textContent = String(p.phase ?? "—");
		runEls.started.textContent = fmt(p.startedAt);
		runEls.updated.textContent = fmt(p.updatedAt);
		runEls.unknown.textContent = String(p.unknown ?? "—");
		runEls.hydrated.textContent = String(p.hydrated ?? "—");
		runEls.renders.textContent = String(p.renders ?? "—");
		runEls.scanned.textContent = String(p.scanned ?? "—");
		runEls.failures.textContent = String(p.failures ?? "—");
		runEls.lastline.textContent = String(p.lastLine ?? "");
	}

	async function refreshRun() {
		try {
			const res = await fetch("/runs/status", { cache: "no-store" });
			if (res.ok) renderRun(await res.json());
		} catch {}
	}
	refreshRun();
	setInterval(refreshRun, 3_000);

	// Initial hydration + revalidate (stale-while-revalidate) then dynamic polling loop.
	const now = Date.now();
	const age =
		cached && typeof cached.fetchedAt === "number"
			? now - cached.fetchedAt
			: Infinity;
	if (age > ttlMs) refresh();
	scheduleNextPoll();
})();
