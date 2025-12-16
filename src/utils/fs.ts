import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function ensureDir(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJsonStable(filePath: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(filePath));
	const normalized = stableSortKeys(data);
	const content = JSON.stringify(normalized, null, 2) + '\n';
	await fs.writeFile(filePath, content, 'utf8');
}

function stableSortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableSortKeys);
	if (!value || typeof value !== 'object') return value;

	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b, 'en'));
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		out[key] = stableSortKeys(obj[key]);
	}
	return out;
}
