export interface RawCharacter {
	name: string;
	descriptions: string[];
	actions: string[];
}

export interface ChunkResult {
	chunkIndex: number;
	characters: RawCharacter[];
}

export interface AggregatedCharacter {
	canonical_name: string;
	aliases: string[];
	mentions: number;
	descriptions: Record<string, number>;
	actions: Record<string, number>;
	chunks: number[];
}

export interface AggregationResult {
	characters: Record<string, AggregatedCharacter>;
}

const HONORIFICS = new Set<string>([
	"mr",
	"mrs",
	"ms",
	"miss",
	"dr",
	"prof",
	"sir",
	"lady",
	"madam",
	"lord",
	"capt",
	"captain",
	"sgt",
	"sergeant",
	"lt",
	"lieutenant"
]);

/**
 * Normalizes a name for conservative matching.
 * - lowercase
 * - remove punctuation (keeps letters/numbers/spaces)
 * - collapse whitespace
 */
export function normalizeName(name: string): string {
	const lower = String(name ?? "").toLowerCase();
	const noPunct = lower.replaceAll(/[^\p{L}\p{N}\s]+/gu, " ");
	return noPunct.replaceAll(/\s+/g, " ").trim();
}

function stripHonorific(name: string): string {
	const n = normalizeName(name);
	if (!n) return n;
	const parts = n.split(" ").filter(Boolean);
	if (parts.length === 0) return "";
	if (HONORIFICS.has(parts[0])) {
		return parts.slice(1).join(" ").trim();
	}
	return n;
}

/**
 * Conservative alias matching.
 * Allowed:
 * - exact normalized match
 * - honorific-stripped match
 * - last-name-only match (single-token equals last token of the other)
 */
export function areAliases(a: string, b: string): boolean {
	const na = normalizeName(a);
	const nb = normalizeName(b);
	if (!na || !nb) return false;
	if (na === nb) return true;

	const sa = stripHonorific(a);
	const sb = stripHonorific(b);
	if (sa && sb && sa === sb) return true;

	// Last-name-only match, conservative:
	// One side is a single token and equals the last token of the other side.
	const aParts = sa.split(" ").filter(Boolean);
	const bParts = sb.split(" ").filter(Boolean);
	if (aParts.length === 1 && bParts.length >= 2 && aParts[0] === bParts.at(-1)) return true;
	if (bParts.length === 1 && aParts.length >= 2 && bParts[0] === aParts.at(-1)) return true;

	return false;
}

interface MentionEvent {
	chunkIndex: number;
	name: string;
	descriptions: string[];
	actions: string[];
}

interface AggregateBucket {
	// Deterministic canonical selection
	canonicalName: string;
	canonicalFirstChunk: number;
	canonicalTieBreaker: string;

	aliases: Set<string>;
	mentions: number;
	descriptions: Map<string, number>;
	actions: Map<string, number>;
	chunks: Set<number>;
}

function incMap(map: Map<string, number>, key: string, delta = 1): void {
	map.set(key, (map.get(key) ?? 0) + delta);
}

function stableSorted<T>(items: Iterable<T>, cmp: (a: T, b: T) => number): T[] {
	return Array.from(items).sort(cmp);
}

function chooseCanonical(existing: AggregateBucket, candidateName: string, candidateChunk: number): void {
	// canonical_name = first-seen name, but chunk execution order is not guaranteed.
	// We define "first-seen" deterministically as the smallest chunkIndex where the character appears.
	// Tie-breaker: lexicographically smallest raw name (case-insensitive by normalizeName).
	if (candidateChunk < existing.canonicalFirstChunk) {
		existing.canonicalFirstChunk = candidateChunk;
		existing.canonicalName = candidateName;
		existing.canonicalTieBreaker = normalizeName(candidateName);
		return;
	}
	if (candidateChunk === existing.canonicalFirstChunk) {
		const candTie = normalizeName(candidateName);
		if (candTie && candTie.localeCompare(existing.canonicalTieBreaker, "en") < 0) {
			existing.canonicalName = candidateName;
			existing.canonicalTieBreaker = candTie;
		}
	}
}

function bucketToAggregated(bucket: AggregateBucket): AggregatedCharacter {
	const descriptions = mapToSortedRecord(bucket.descriptions);
	const actions = mapToSortedRecord(bucket.actions);
	const aliases = stableSorted(bucket.aliases, (a, b) => a.localeCompare(b, "en"));
	const chunks = stableSorted(bucket.chunks, (a, b) => a - b);

	return {
		canonical_name: bucket.canonicalName,
		aliases,
		mentions: bucket.mentions,
		descriptions,
		actions,
		chunks
	};
}

function mapToSortedRecord(map: Map<string, number>): Record<string, number> {
	const entries = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], "en"));
	const out: Record<string, number> = {};
	for (const [k, v] of entries) out[k] = v;
	return out;
}

/**
 * Aggregate per-chunk character mentions into deterministic, inspectable character records.
 * Pure function: no VS Code APIs, no filesystem, no LLM calls.
 */
export function aggregateCharacters(chunks: ChunkResult[]): AggregationResult {
	const mentionEvents = sortMentionEvents(collectMentionEvents(chunks));
	const buckets = buildBuckets(mentionEvents);
	return buildResult(buckets);
}

function collectMentionEvents(chunks: ChunkResult[] | undefined): MentionEvent[] {
	const mentionEvents: MentionEvent[] = [];
	for (const chunk of chunks ?? []) {
		const chunkIndex = getValidChunkIndex(chunk);
		if (chunkIndex === undefined) continue;
		pushChunkEvents(mentionEvents, chunkIndex, chunk.characters ?? []);
	}
	return mentionEvents;
}

function getValidChunkIndex(chunk: ChunkResult): number | undefined {
	if (!chunk) return undefined;
	if (!Number.isFinite(chunk.chunkIndex)) return undefined;
	return chunk.chunkIndex;
}

function pushChunkEvents(out: MentionEvent[], chunkIndex: number, chars: RawCharacter[]): void {
	for (const c of chars ?? []) {
		const name = typeof c?.name === "string" ? c.name : "";
		if (!name.trim()) continue;
		out.push({
			chunkIndex,
			name,
			descriptions: Array.isArray(c.descriptions) ? c.descriptions : [],
			actions: Array.isArray(c.actions) ? c.actions : []
		});
	}
}

function sortMentionEvents(events: MentionEvent[]): MentionEvent[] {
	// Determinism: sort so merge/canonical behavior is independent of upstream chunk execution order.
	return events.sort((a, b) => {
		if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
		const an = normalizeName(a.name);
		const bn = normalizeName(b.name);
		const c = an.localeCompare(bn, "en");
		if (c !== 0) return c;
		return a.name.localeCompare(b.name, "en");
	});
}

function buildBuckets(events: MentionEvent[]): AggregateBucket[] {
	const buckets: AggregateBucket[] = [];
	for (const ev of events) {
		const bucket = findOrCreateBucket(buckets, ev);
		applyEvent(bucket, ev);
	}
	return buckets;
}

function findOrCreateBucket(buckets: AggregateBucket[], ev: MentionEvent): AggregateBucket {
	const existing = findMatchingBucket(buckets, ev.name);
	if (existing) return existing;
	const created = createBucket(ev);
	buckets.push(created);
	return created;
}

function findMatchingBucket(buckets: AggregateBucket[], name: string): AggregateBucket | undefined {
	for (const bucket of buckets) {
		for (const alias of bucket.aliases) {
			if (areAliases(alias, name)) return bucket;
		}
	}
	return undefined;
}

function createBucket(ev: MentionEvent): AggregateBucket {
	return {
		canonicalName: ev.name,
		canonicalFirstChunk: ev.chunkIndex,
		canonicalTieBreaker: normalizeName(ev.name),
		aliases: new Set<string>(),
		mentions: 0,
		descriptions: new Map<string, number>(),
		actions: new Map<string, number>(),
		chunks: new Set<number>()
	};
}

function applyEvent(bucket: AggregateBucket, ev: MentionEvent): void {
	bucket.aliases.add(ev.name);
	bucket.mentions += 1;
	bucket.chunks.add(ev.chunkIndex);
	chooseCanonical(bucket, ev.name, ev.chunkIndex);

	for (const d of ev.descriptions) {
		if (typeof d === "string" && d.length > 0) incMap(bucket.descriptions, d);
	}
	for (const a of ev.actions) {
		if (typeof a === "string" && a.length > 0) incMap(bucket.actions, a);
	}
}

function buildResult(buckets: AggregateBucket[]): AggregationResult {
	const charactersEntries: Array<[string, AggregatedCharacter]> = buckets
		.map((b) => bucketToAggregated(b))
		.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name, "en"))
		.map((c) => [c.canonical_name, c]);

	const characters: Record<string, AggregatedCharacter> = {};
	for (const [k, v] of charactersEntries) characters[k] = v;
	return { characters };
}

/**
 * Utility for callers that build Maps/Sets and want JSON-safe output.
 * (Not used by aggregateCharacters output, which is already JSON-safe.)
 */
export function toJsonSafe(value: unknown): unknown {
	if (value instanceof Map) {
		const entries = Array.from(value.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en"));
		const obj: Record<string, unknown> = {};
		for (const [k, v] of entries) obj[String(k)] = toJsonSafe(v);
		return obj;
	}
	if (value instanceof Set) {
		const arr = Array.from(value.values()).map(toJsonSafe);
		arr.sort((a, b) => String(a).localeCompare(String(b), "en"));
		return arr;
	}
	if (Array.isArray(value)) return value.map(toJsonSafe);
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b, "en"));
		const out: Record<string, unknown> = {};
		for (const k of keys) out[k] = toJsonSafe(obj[k]);
		return out;
	}
	return value;
}
