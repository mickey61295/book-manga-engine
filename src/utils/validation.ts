import type { ChunkMentionsResult } from '../pipeline/types';

export function parseFirstJsonObject(text: string): unknown {
	const trimmed = String(text ?? '').trim();
	const first = trimmed.indexOf('{');
	const last = trimmed.lastIndexOf('}');
	if (first < 0 || last < 0 || last <= first) {
		throw new Error('No JSON object found in model output');
	}
	const candidate = trimmed.slice(first, last + 1);
	return JSON.parse(candidate);
}

export function validateChunkMentionsResult(value: unknown): value is ChunkMentionsResult {
	if (!value || typeof value !== 'object') return false;
	const v = value as any;
	if (!Number.isInteger(v.chunkIndex)) return false;
	if (!Array.isArray(v.characters)) return false;

	for (const c of v.characters) {
		if (!c || typeof c !== 'object') return false;
		if (typeof c.name !== 'string' || c.name.trim().length === 0) return false;
		if (!Array.isArray(c.descriptions) || !c.descriptions.every((s: any) => typeof s === 'string')) return false;
		if (!Array.isArray(c.actions) || !c.actions.every((s: any) => typeof s === 'string')) return false;
	}

	return true;
}

export function normalizeChunkMentionsResult(result: ChunkMentionsResult): ChunkMentionsResult {
	const normalized = {
		chunkIndex: result.chunkIndex,
		characters: result.characters
			.map((c) => ({
				name: c.name.trim(),
				descriptions: normalizeStringList(c.descriptions),
				actions: normalizeStringList(c.actions)
			}))
			.sort((a, b) => a.name.localeCompare(b.name, 'en'))
	};

	return normalized;
}

function normalizeStringList(values: string[]): string[] {
	const cleaned = values
		.map((v) => v.trim())
		.filter((v) => v.length > 0);

	const uniq = Array.from(new Set(cleaned));
	uniq.sort((a, b) => a.localeCompare(b, 'en'));
	return uniq;
}
