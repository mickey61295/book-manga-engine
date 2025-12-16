import { normalizeName } from './aggregator';
import type { ChunkScenesResult, SceneAction, SceneFragment } from './sceneExtractor';

export interface NormalizedSceneAction {
	character_id: string;
	action: string;
}

export interface NormalizedScene {
	scene_id: string;
	order: number;
	location: string | null;
	time: string | null;
	characters_present: string[];
	actions: NormalizedSceneAction[];
	source_chunks: number[];
}

export interface ScenesRawArtifact {
	sourceFile?: string;
	chunkSize?: number;
	overlap?: number;
	scenes_by_chunk: ChunkScenesResult[];
}

export interface CanonicalCharactersArtifact {
	characters: Record<string, unknown>;
}

interface CanonicalCharacterInfo {
	character_id: string;
	drawable: boolean;
	aliases: string[];
}

interface CanonicalIndex {
	byId: Map<string, CanonicalCharacterInfo>;
	aliasToIds: Map<string, string[]>;
	drawableIds: Set<string>;
}

export function normalizeAndMergeScenes(
	raw: ScenesRawArtifact,
	canonical: CanonicalCharactersArtifact
): { scenes: NormalizedScene[] } {
	const index = buildCanonicalIndex(canonical);
	const normalized = normalizeAll(raw, index);
	const merged = mergeOverlapping(normalized);

	// Deterministic global ordering and stable IDs.
	merged.sort((a, b) => compareOrderKey(a, b));

	const out: NormalizedScene[] = merged.map((s, i) => ({
		scene_id: `scene_${String(i + 1).padStart(3, '0')}`,
		order: i + 1,
		location: s.location,
		time: s.time,
		characters_present: s.characters_present,
		actions: s.actions,
		source_chunks: s.source_chunks
	}));

	return { scenes: out };
}

interface SceneOrderKey {
	minChunk: number;
	minOrderHint: number;
	stableTie: string;
}

interface NormalizedSceneInternal {
	orderKey: SceneOrderKey;
	location: string | null;
	time: string | null;
	characters_present: string[];
	actions: NormalizedSceneAction[];
	source_chunks: number[];
}

function normalizeAll(raw: ScenesRawArtifact, index: CanonicalIndex): NormalizedSceneInternal[] {
	const chunks = Array.isArray(raw?.scenes_by_chunk) ? raw.scenes_by_chunk : [];
	const out: NormalizedSceneInternal[] = [];

	for (const chunk of chunks) {
		const chunkIndex = Number.isFinite(chunk?.chunkIndex) ? chunk.chunkIndex : undefined;
		if (chunkIndex === undefined) continue;
		const scenes = Array.isArray(chunk?.scenes) ? chunk.scenes : [];

		for (const scene of scenes) {
			const normalized = normalizeOneScene(scene, { fallbackChunkIndex: chunkIndex }, index);
			if (normalized) out.push(normalized);
		}
	}

	return out;
}

function normalizeOneScene(
	scene: SceneFragment,
	ctx: { fallbackChunkIndex: number },
	index: CanonicalIndex
): NormalizedSceneInternal | null {
	const location = normalizeNullableText(scene?.location ?? null);
	const time = normalizeNullableText(scene?.time ?? null);

	const rawChunks = Array.isArray(scene?.source_chunks) ? scene.source_chunks : [ctx.fallbackChunkIndex];
	const source_chunks = normalizeChunkList(rawChunks, ctx.fallbackChunkIndex);

	const rawCharacters = Array.isArray(scene?.characters_present) ? scene.characters_present : [];
	const rawActions = Array.isArray(scene?.actions) ? scene.actions : [];

	const present = resolveDrawablePresent(rawCharacters, index);
	const actions = resolveDrawableActions(rawActions, index);
	for (const a of actions) present.add(a.character_id);

	const characters_present = Array.from(present).sort((a, b) => a.localeCompare(b, 'en'));

	if (characters_present.length === 0 && actions.length === 0) return null;

	const minChunk = source_chunks.length ? source_chunks[0] : ctx.fallbackChunkIndex;
	const minOrderHint = Number.isFinite(scene?.order_hint) ? scene.order_hint : minChunk * 1000;
	const stableTie = typeof scene?.scene_id === 'string' ? scene.scene_id : `c${ctx.fallbackChunkIndex}`;

	return {
		orderKey: { minChunk, minOrderHint, stableTie },
		location,
		time,
		characters_present,
		actions: dedupeActionsStable(actions),
		source_chunks
	};
}

function resolveDrawablePresent(rawCharacters: unknown[], index: CanonicalIndex): Set<string> {
	const present = new Set<string>();
	for (const ref of rawCharacters ?? []) {
		if (typeof ref !== 'string') continue;
		const resolved = resolveCharacterRef(ref, index);
		if (!resolved) continue;
		if (!index.drawableIds.has(resolved)) continue;
		present.add(resolved);
	}
	return present;
}

function resolveDrawableActions(rawActions: unknown[], index: CanonicalIndex): NormalizedSceneAction[] {
	const actions: NormalizedSceneAction[] = [];
	for (const a of rawActions ?? []) {
		const normalized = normalizeOneAction(a as SceneAction, index);
		if (!normalized) continue;
		actions.push(normalized);
	}
	return actions;
}

function normalizeOneAction(action: SceneAction, index: CanonicalIndex): NormalizedSceneAction | null {
	const rawRef = typeof action?.character_id === 'string' ? action.character_id : '';
	const resolved = resolveCharacterRef(rawRef, index);
	if (!resolved) return null;
	if (!index.drawableIds.has(resolved)) return null;

	const rawText = typeof action?.action === 'string' ? action.action : '';
	const cleaned = normalizeActionText(rawText);
	if (!cleaned) return null;

	return { character_id: resolved, action: cleaned };
}

function resolveCharacterRef(raw: string, index: CanonicalIndex): string | null {
	const direct = String(raw ?? '').trim();
	if (direct.length === 0) return null;
	if (index.byId.has(direct)) return direct;

	const key = normalizeName(direct);
	if (!key) return null;
	const ids = index.aliasToIds.get(key);
	if (ids?.length !== 1) return null;
	return ids?.[0] ?? null;
}

function buildCanonicalIndex(canonical: CanonicalCharactersArtifact): CanonicalIndex {
	const byId = new Map<string, CanonicalCharacterInfo>();
	const aliasToIds = new Map<string, string[]>();
	const drawableIds = new Set<string>();

	const chars = getCanonicalCharactersObject(canonical);
	for (const [key, value] of Object.entries(chars)) {
		const entry = parseCanonicalEntry(key, value);
		if (!entry) continue;
		byId.set(entry.character_id, entry);
		if (entry.drawable) drawableIds.add(entry.character_id);
		addAliases(aliasToIds, entry.character_id, entry.aliases);
	}

	// Determinism: sort id lists and de-dup.
	for (const [aliasKey, ids] of aliasToIds.entries()) {
		const uniq = Array.from(new Set(ids));
		uniq.sort((a, b) => a.localeCompare(b, 'en'));
		aliasToIds.set(aliasKey, uniq);
	}

	return { byId, aliasToIds, drawableIds };
}

function getCanonicalCharactersObject(canonical: CanonicalCharactersArtifact): Record<string, unknown> {
	if (!canonical || typeof canonical !== 'object') return {};
	const c = (canonical as any).characters;
	if (!c || typeof c !== 'object') return {};
	return c as Record<string, unknown>;
}

function parseCanonicalEntry(key: string, value: unknown): CanonicalCharacterInfo | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as any;
	const character_id = typeof v.character_id === 'string' && v.character_id.trim().length > 0 ? v.character_id.trim() : key;
	const drawable = Boolean(v.drawable);
	const aliases = normalizeAliases(v.aliases, key, character_id);
	return { character_id, drawable, aliases };
}

function addAliases(map: Map<string, string[]>, characterId: string, aliases: string[]): void {
	for (const alias of aliases) {
		const aliasKey = normalizeName(alias);
		if (!aliasKey) continue;
		const existing = map.get(aliasKey) ?? [];
		existing.push(characterId);
		map.set(aliasKey, existing);
	}
}

function normalizeAliases(value: unknown, key: string, characterId: string): string[] {
	const raw = Array.isArray(value) ? value : [];
	const out: string[] = [];

	for (const a of raw) {
		if (typeof a !== 'string') continue;
		const t = a.trim();
		if (t) out.push(t);
	}

	// Ensure stable identity strings are resolvable.
	if (key && !out.includes(key)) out.push(key);
	if (characterId && !out.includes(characterId)) out.push(characterId);

	const uniq = Array.from(new Set(out));
	uniq.sort((a, b) => a.localeCompare(b, 'en'));
	return uniq;
}

function normalizeNullableText(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t.length ? t : null;
}

function normalizeChunkList(raw: unknown[], fallback: number): number[] {
	const nums: number[] = [];
	for (const x of raw ?? []) {
		const n = typeof x === 'number' ? x : Number(x);
		if (!Number.isFinite(n)) continue;
		nums.push(n);
	}
	if (nums.length === 0 && Number.isFinite(fallback)) nums.push(fallback);
	const uniq = Array.from(new Set(nums));
	uniq.sort((a, b) => a - b);
	return uniq;
}

function normalizeActionText(text: string): string {
	let t = String(text ?? '').trim();
	if (!t) return '';

	// Conservative pronoun stripping (subject-only) to avoid preserving pronouns in action text.
	// Only strip when the action clearly starts with a pronoun token.
	t = t.replace(/^(i|we|me|us|my|our|mine|ours)\b\s+/i, '');
	// Collapse whitespace.
	t = t.replaceAll(/\s+/g, ' ').trim();
	return t;
}

function dedupeActionsStable(actions: NormalizedSceneAction[]): NormalizedSceneAction[] {
	const seen = new Set<string>();
	const out: NormalizedSceneAction[] = [];
	for (const a of actions) {
		const key = `${a.character_id}|${normalizeActionKey(a.action)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(a);
	}
	return out;
}

function normalizeActionKey(action: string): string {
	return String(action ?? '').trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function mergeOverlapping(scenes: NormalizedSceneInternal[]): NormalizedSceneInternal[] {
	const items = scenes.slice();
	items.sort((a, b) => compareOrderKey(a, b));

	const parent = items.map((_, i) => i);

	const find = (x: number): number => {
		let p = parent[x];
		while (p !== parent[p]) p = parent[p];
		let cur = x;
		while (parent[cur] !== p) {
			const next = parent[cur];
			parent[cur] = p;
			cur = next;
		}
		return p;
	};

	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra === rb) return;
		// Determinism: attach higher index to lower.
		if (ra < rb) parent[rb] = ra;
		else parent[ra] = rb;
	};

	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			// Fast reject: if chunks are far apart, no need to compare further.
			if (!chunksOverlap(items[i].source_chunks, items[j].source_chunks)) continue;
			if (!locationTimeMatch(items[i], items[j])) continue;
			if (!charactersOverlap(items[i].characters_present, items[j].characters_present)) continue;
			union(i, j);
		}
	}

	const groups = new Map<number, NormalizedSceneInternal[]>();
	for (let i = 0; i < items.length; i++) {
		const r = find(i);
		const arr = groups.get(r) ?? [];
		arr.push(items[i]);
		groups.set(r, arr);
	}

	const merged: NormalizedSceneInternal[] = [];
	for (const group of groups.values()) {
		merged.push(mergeGroup(group));
	}

	return merged;
}

function mergeGroup(group: NormalizedSceneInternal[]): NormalizedSceneInternal {
	const sorted = group.slice().sort((a, b) => compareOrderKey(a, b));
	const first = sorted[0];

	const characters = new Set<string>();
	const chunks = new Set<number>();
	for (const s of sorted) {
		for (const c of s.characters_present) characters.add(c);
		for (const ch of s.source_chunks) chunks.add(ch);
	}

	const actions = collectActionsStable(sorted);
	for (const a of actions) characters.add(a.character_id);

	const characters_present = Array.from(characters);
	characters_present.sort((a, b) => a.localeCompare(b, 'en'));

	const source_chunks = Array.from(chunks);
	source_chunks.sort((a, b) => a - b);

	return {
		orderKey: minOrderKey(sorted),
		location: first.location,
		time: first.time,
		characters_present,
		actions,
		source_chunks
	};
}

function collectActionsStable(sorted: NormalizedSceneInternal[]): NormalizedSceneAction[] {
	const seen = new Set<string>();
	const out: NormalizedSceneAction[] = [];
	for (const s of sorted) {
		for (const a of s.actions) {
			const key = `${a.character_id}|${normalizeActionKey(a.action)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(a);
		}
	}
	return out;
}

function minOrderKey(items: NormalizedSceneInternal[]): SceneOrderKey {
	let best = items[0].orderKey;
	for (const s of items) {
		if (compareOrderKeyRaw(s.orderKey, best) < 0) best = s.orderKey;
	}
	return best;
}

function compareOrderKey(a: NormalizedSceneInternal, b: NormalizedSceneInternal): number {
	return compareOrderKeyRaw(a.orderKey, b.orderKey);
}

function compareOrderKeyRaw(a: SceneOrderKey, b: SceneOrderKey): number {
	if (a.minChunk !== b.minChunk) return a.minChunk - b.minChunk;
	if (a.minOrderHint !== b.minOrderHint) return a.minOrderHint - b.minOrderHint;
	return a.stableTie.localeCompare(b.stableTie, 'en');
}

function locationTimeMatch(a: NormalizedSceneInternal, b: NormalizedSceneInternal): boolean {
	const al = a.location ? normalizeName(a.location) : '';
	const bl = b.location ? normalizeName(b.location) : '';
	if (al !== bl) return false;
	const at = a.time ? normalizeName(a.time) : '';
	const bt = b.time ? normalizeName(b.time) : '';
	return at === bt;
}

function charactersOverlap(a: string[], b: string[]): boolean {
	if (a.length === 0 || b.length === 0) return false;
	const small = a.length <= b.length ? a : b;
	const large = a.length <= b.length ? b : a;
	const set = new Set(large);
	for (const x of small) {
		if (set.has(x)) return true;
	}
	return false;
}

function chunksOverlap(a: number[], b: number[]): boolean {
	if (a.length === 0 || b.length === 0) return false;

	// True overlap.
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) return true;
		if (a[i] < b[j]) i += 1;
		else j += 1;
	}

	// Adjacent-chunk overlap (chunker overlap implies narrative overlap across neighbors).
	i = 0;
	j = 0;
	while (i < a.length && j < b.length) {
		const diff = a[i] - b[j];
		if (Math.abs(diff) <= 1) return true;
		if (diff < 0) i += 1;
		else j += 1;
	}

	return false;
}
