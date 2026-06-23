import React from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";

function App() {
	const [hash, setHash] = React.useState("");
	const [html, setHtml] = React.useState("");
	const [error, setError] = React.useState("");
	const [loading, setLoading] = React.useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!hash.trim()) return;
		setLoading(true);
		setError("");
		setHtml("");
		try {
			const res = await fetch(`/api/cast/${encodeURIComponent(hash.trim())}`);
			if (!res.ok) {
				const body = await res.json();
				throw new Error(body.error ?? res.statusText);
			}
			const data = (await res.json()) as { markdown: string };
			setHtml(marked.parse(data.markdown) as string);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="min-h-dvh bg-base-200 text-base-content flex items-center justify-center p-4">
			<div className="w-full max-w-xl">
				<form onSubmit={handleSubmit} className="flex gap-2">
					<input
						type="text"
						placeholder="Cast hash"
						className="input input-bordered flex-1"
						value={hash}
						onChange={(e) => setHash(e.target.value)}
					/>
					<button
						type="submit"
						className="btn btn-primary"
						disabled={loading || !hash.trim()}
					>
						{loading ? (
							<span className="loading loading-spinner loading-sm" />
						) : (
							"Load"
						)}
					</button>
				</form>

				{error && (
					<div className="alert alert-error mt-4">
						<span>{error}</span>
					</div>
				)}

				{html && (
					<div
						className="mt-4 bg-base-100 rounded-lg p-4 prose prose-invert max-w-none"
						dangerouslySetInnerHTML={{ __html: html }}
					/>
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
