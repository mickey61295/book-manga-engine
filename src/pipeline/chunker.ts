export interface ChunkingOptions {
	chunkSize: number;
	overlap: number;
}

/**
 * Deterministic chunking by character count with overlap.
 * Each chunk is independent; overlap helps avoid boundary misses.
 */
export function chunkText(text: string, opts: ChunkingOptions): string[] {
	const chunkSize = Math.max(1, Math.floor(opts.chunkSize));
	const overlap = Math.max(0, Math.floor(opts.overlap));
	const step = Math.max(1, chunkSize - overlap);

	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += step) {
		const end = Math.min(text.length, start + chunkSize);
		chunks.push(text.slice(start, end));
		if (end >= text.length) break;
	}

	return chunks;
}
