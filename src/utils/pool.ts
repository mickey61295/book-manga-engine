export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const limit = Math.max(1, Math.floor(concurrency));
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function runOne(): Promise<void> {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	}

	const runners = Array.from({ length: Math.min(limit, items.length) }, () => runOne());
	await Promise.all(runners);
	return results;
}
