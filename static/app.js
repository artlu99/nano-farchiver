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

	// Initial hydration + revalidate (stale-while-revalidate) then dynamic polling loop.
	const now = Date.now();
	const age =
		cached && typeof cached.fetchedAt === "number"
			? now - cached.fetchedAt
			: Infinity;
	if (age > ttlMs) refresh();
	scheduleNextPoll();
})();
