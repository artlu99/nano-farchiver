import React from "react";
import { createRoot } from "react-dom/client";

interface Candidate {
	hash: string;
	ts_iso: string;
	age_days: number;
	text_preview: string;
	backed_up: boolean;
}

interface ReviewPage {
	candidates: Candidate[];
	page: number;
	total: number;
	total_pages: number;
	policy: { minAgeDays: number; source: string };
}

interface DeletedEntry {
	hash: string;
	deleted_at: number;
	reason: string;
	backed_up: boolean;
}

const token = (): string => localStorage.getItem("review_token") ?? "";

const api = async (path: string, init?: RequestInit): Promise<unknown> => {
	const sep = path.includes("?") ? "&" : "?";
	const res = await fetch(`${path}${sep}token=${encodeURIComponent(token())}`, {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});
	if (res.status === 404)
		throw new Error("not authorized — check REVIEW_TOKEN");
	const body = (await res.json()) as { error?: string };
	if (!res.ok || body.error) throw new Error(body.error ?? res.statusText);
	return body;
};

function App() {
	const [authed, setAuthed] = React.useState(token().length > 0);
	const [tab, setTab] = React.useState<"candidates" | "deleted">("candidates");
	const [page, setPage] = React.useState(1);
	const [data, setData] = React.useState<ReviewPage | null>(null);
	const [deleted, setDeleted] = React.useState<{
		deleted: DeletedEntry[];
		total: number;
		page: number;
		total_pages: number;
	} | null>(null);
	const [error, setError] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [notice, setNotice] = React.useState("");

	const load = React.useCallback(async () => {
		setError("");
		try {
			if (tab === "candidates") {
				setData((await api(`/review/candidates?page=${page}`)) as ReviewPage);
			} else {
				setDeleted((await api(`/review/deleted?page=${page}`)) as never);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [tab, page]);

	React.useEffect(() => {
		if (authed) void load();
	}, [authed, load]);

	const act = async (label: string, path: string) => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await api(path, { method: "POST" });
			setNotice(`${label}: ok`);
			await load();
		} catch (err) {
			setError(
				`${label} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setBusy(false);
		}
	};

	const setPolicy = async (value: string) => {
		setBusy(true);
		setError("");
		try {
			await api("/review/policy", {
				method: "POST",
				body: JSON.stringify({ min_age_days: Number(value) }),
			});
			setNotice(`policy set to ${value}d`);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (!authed) {
		return (
			<div className="min-h-dvh bg-base-200 text-base-content flex items-center justify-center p-4">
				<form
					className="w-full max-w-sm bg-base-100 rounded-lg p-6 space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						const input = (
							e.currentTarget.elements.namedItem("token") as HTMLInputElement
						).value;
						localStorage.setItem("review_token", input);
						setAuthed(true);
					}}
				>
					<h1 className="text-lg font-semibold">purge review</h1>
					<input
						name="token"
						type="password"
						placeholder="REVIEW_TOKEN"
						className="input input-bordered w-full"
					/>
					<button type="submit" className="btn btn-primary w-full">
						unlock
					</button>
				</form>
			</div>
		);
	}

	const policyInput = React.useRef<HTMLInputElement>(null);

	return (
		<div className="min-h-dvh bg-base-200 text-base-content p-4">
			<div className="max-w-3xl mx-auto space-y-3">
				<div className="flex items-center gap-2">
					<h1 className="text-lg font-semibold mr-auto">purge review</h1>
					<button
						className={`btn btn-sm ${tab === "candidates" ? "btn-primary" : "btn-ghost"}`}
						onClick={() => {
							setTab("candidates");
							setPage(1);
						}}
					>
						candidates
					</button>
					<button
						className={`btn btn-sm ${tab === "deleted" ? "btn-primary" : "btn-ghost"}`}
						onClick={() => {
							setTab("deleted");
							setPage(1);
						}}
					>
						deleted
					</button>
				</div>

				{data && (
					<div className="bg-base-100 rounded-lg p-3 text-sm flex flex-wrap items-center gap-2">
						<span className="font-mono">{data.total}</span> candidate(s) ·
						min-age <span className="font-mono">{data.policy.minAgeDays}d</span>{" "}
						({data.policy.source})
						<form
							className="ml-auto flex gap-1"
							onSubmit={(e) => {
								e.preventDefault();
								const v = policyInput.current?.value;
								if (v) void setPolicy(v);
							}}
						>
							<input
								ref={policyInput}
								type="number"
								min="0"
								placeholder="days"
								className="input input-xs input-bordered w-20"
							/>
							<button className="btn btn-xs" disabled={busy}>
								set policy
							</button>
						</form>
						<button
							className="btn btn-xs"
							disabled={busy}
							onClick={() => void act("verify-all", "/review/verify-all")}
						>
							backup+verify all
						</button>
						<button
							className="btn btn-xs btn-error"
							disabled={busy}
							onClick={() => {
								if (
									confirm(
										"delete all verified candidates in this batch? this submits CastRemove messages — irreversible on the network.",
									)
								) {
									void act("purge", "/review/purge");
								}
							}}
						>
							delete all verified
						</button>
					</div>
				)}

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}
				{notice && (
					<div className="alert alert-success text-sm">
						<span>{notice}</span>
					</div>
				)}

				{tab === "candidates" && data && (
					<div className="space-y-2">
						{data.candidates.length === 0 && (
							<div className="bg-base-100 rounded-lg p-4 text-sm opacity-70">
								no candidates — everything is liked, tombstoned, or inside the
								age policy.
							</div>
						)}
						{data.candidates.map((candidate) => (
							<div
								key={candidate.hash}
								className="bg-base-100 rounded-lg p-3 text-sm space-y-2"
							>
								<div className="flex items-center gap-2 text-xs opacity-70">
									<span className="font-mono">
										{candidate.hash.slice(0, 10)}…
									</span>
									<span>{candidate.ts_iso.slice(0, 10)}</span>
									<span>{candidate.age_days}d old</span>
									<span
										className={`badge badge-xs ${candidate.backed_up ? "badge-success" : "badge-warning"}`}
									>
										{candidate.backed_up
											? "verified backup ✓"
											: "no backup yet"}
									</span>
								</div>
								<p className="whitespace-pre-wrap">
									{candidate.text_preview || "(no text)"}
								</p>
								<div className="flex gap-2">
									<button
										className="btn btn-xs btn-success"
										disabled={busy}
										onClick={() => {
											if (
												confirm(
													"like this cast to keep it? submits a ReactionAdd from your signer.",
												)
											) {
												void act(
													`like ${candidate.hash.slice(0, 8)}`,
													`/review/like/${candidate.hash}`,
												);
											}
										}}
									>
										keep (like)
									</button>
									<button
										className="btn btn-xs btn-error"
										disabled={busy}
										onClick={() => {
											if (
												confirm(
													"delete this cast? irreversible on the network; the verified backup keeps it locally.",
												)
											) {
												void act(
													`delete ${candidate.hash.slice(0, 8)}`,
													`/review/delete/${candidate.hash}`,
												);
											}
										}}
									>
										delete
									</button>
								</div>
							</div>
						))}
						<div className="flex items-center gap-2 text-sm">
							<button
								className="btn btn-xs"
								disabled={page <= 1 || busy}
								onClick={() => setPage(page - 1)}
							>
								prev
							</button>
							<span className="opacity-70">
								page {data.page} / {data.total_pages}
							</span>
							<button
								className="btn btn-xs"
								disabled={page >= data.total_pages || busy}
								onClick={() => setPage(page + 1)}
							>
								next
							</button>
						</div>
					</div>
				)}

				{tab === "deleted" && deleted && (
					<div className="space-y-1">
						{deleted.deleted.map((entry) => (
							<div
								key={entry.hash}
								className="bg-base-100 rounded-lg p-2 text-xs flex items-center gap-2"
							>
								<span className="font-mono">{entry.hash.slice(0, 12)}…</span>
								<span className="opacity-70">
									{new Date(entry.deleted_at).toISOString().slice(0, 10)}
								</span>
								<span className="badge badge-ghost badge-xs">
									{entry.reason}
								</span>
								{entry.backed_up ? (
									<span className="badge badge-success badge-xs">backup ✓</span>
								) : (
									<span className="badge badge-error badge-xs">NO BACKUP</span>
								)}
							</div>
						))}
						<div className="flex items-center gap-2 text-sm pt-2">
							<button
								className="btn btn-xs"
								disabled={page <= 1 || busy}
								onClick={() => setPage(page - 1)}
							>
								prev
							</button>
							<span className="opacity-70">
								page {deleted.page} / {deleted.total_pages} ({deleted.total}{" "}
								total)
							</span>
							<button
								className="btn btn-xs"
								disabled={page >= deleted.total_pages || busy}
								onClick={() => setPage(page + 1)}
							>
								next
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
