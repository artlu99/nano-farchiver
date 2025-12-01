export function pluralize(count: number, word: string, plural = `${word}s`) {
	return `${count} ${count === 1 ? word : plural}`;
}