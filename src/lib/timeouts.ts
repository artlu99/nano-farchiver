type TimeoutOptions = {
	timeoutMs: number;
	timeoutMessage: string;
	warnAfterMs?: number;
	warn?: () => void;
	onTimeout?: () => void | Promise<void>;
};

export const withTimeout = async <T>(
	promise: Promise<T>,
	options: TimeoutOptions,
): Promise<T> => {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let warnId: ReturnType<typeof setTimeout> | undefined;

	try {
		return await new Promise<T>((resolve, reject) => {
			timeoutId = setTimeout(
				() => {
					if (options.onTimeout) {
						Promise.resolve()
							.then(() => options.onTimeout?.())
							.catch((e) =>
								console.error(
									e instanceof Error ? e.message : String(e),
								),
							);
					}
					reject(new Error(options.timeoutMessage));
				},
				options.timeoutMs,
			);

			if (options.warnAfterMs !== undefined && options.warn) {
				warnId = setTimeout(options.warn, options.warnAfterMs);
				(warnId as unknown as { unref?: () => void }).unref?.();
			}

			promise.then(resolve, reject);
		});
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		if (warnId) clearTimeout(warnId);
	}
};

