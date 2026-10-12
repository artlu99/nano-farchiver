const totals = new Map<string, { ms: number; count: number }>();

const record = (name: string, ms: number) => {
	const entry = totals.get(name) ?? { ms: 0, count: 0 };
	entry.ms += ms;
	entry.count += 1;
	totals.set(name, entry);
};

export const timeAsync = async <T>(
	name: string,
	fn: () => Promise<T>,
): Promise<T> => {
	const start = performance.now();
	try {
		return await fn();
	} finally {
		record(name, performance.now() - start);
	}
};

export const resetTimers = () => {
	totals.clear();
};

export const timerReport = (): string =>
	[...totals.entries()]
		.map(([name, { ms, count }]) => `${name}: ${ms.toFixed(0)}ms x${count}`)
		.join("\n");
