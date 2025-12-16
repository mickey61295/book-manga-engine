import { normalizeName } from './aggregator';

export type Confidence = 'high' | 'medium' | 'low';

export interface AppearanceTraits {
	clothing: string | null;
	hair: string | null;
	condition: string | null;
	notes: string[];
}

export interface AppearanceState {
	state_id: string;
	is_new_state: boolean;
	derived_from_state_id: string | null;
	traits: AppearanceTraits;
	confidence: Confidence;
}

export interface AppearanceEvent {
	character_id: string;
	scene_id: string;
	appearance_state: AppearanceState;
}

export interface AppearanceStatesFile {
	[character_id: string]: Array<{
		state_id: string;
		traits: AppearanceTraits;
		confidence: Confidence;
	}>;
}

export interface CanonicalCharactersArtifact {
	characters: Record<string, unknown>;
}

export interface ScenesArtifact {
	scenes: Array<{
		scene_id: string;
		order: number;
		location: string | null;
		time: string | null;
		characters_present: string[];
		actions: Array<{ character_id: string; action: string }>;
		source_chunks: number[];
	}>;
}

export interface ClassifiedScenesArtifact {
	scenes: Array<{ scene_id: string; order: number; drawable: boolean }>; // extra fields ignored
}

interface CanonicalIndex {
	drawableIds: Set<string>;
}

const GARMENT_WORDS = [
	'cloak',
	'coat',
	'dress',
	'gown',
	'jacket',
	'uniform',
	'hat',
	'cap',
	'bonnet',
	'shawl',
	'mantle',
	'boots',
	'shoes',
	'gloves',
	'scarf',
	'hood'
];

const CONDITION_WORDS = [
	'wet',
	'soaked',
	'drenched',
	'muddy',
	'dirty',
	'exhausted',
	'tired',
	'wounded',
	'injured',
	'bleeding',
	'bloodied',
	'pale',
	'shivering',
	'feverish',
	'ill',
	'sick'
];

export function detectAppearanceStates(params: {
	scenesPovResolved: ScenesArtifact;
	scenesClassified: ClassifiedScenesArtifact;
	canonicalCharacters: CanonicalCharactersArtifact;
	existingStates?: AppearanceStatesFile;
}): {
	scenes_drawable: ScenesArtifact;
	appearance_events: { appearances: AppearanceEvent[] };
	appearance_states: AppearanceStatesFile;
} {
	const index = buildCanonicalIndex(params.canonicalCharacters);
	const drawableSceneIds = buildDrawableSceneIdSet(params.scenesClassified);
	const drawableScenes = selectDrawableScenes(params.scenesPovResolved, drawableSceneIds);

	const existing = sanitizeExistingStates(params.existingStates);
	const stateStore: AppearanceStatesFile = { ...existing };
	ensureBaselineStates(stateStore, index);

	const appearances: AppearanceEvent[] = [];
	for (const scene of drawableScenes.scenes) {
		const participants = getDrawableParticipants(scene, index);
		for (const characterId of participants) {
			const ev = detectForCharacterInScene(characterId, scene, stateStore);
			if (ev) appearances.push(ev);
		}
	}

	// Deterministic ordering: by scene order, then character_id.
	appearances.sort((a, b) => {
		const ao = getSceneOrder(drawableScenes, a.scene_id);
		const bo = getSceneOrder(drawableScenes, b.scene_id);
		if (ao !== bo) return ao - bo;
		const c = a.character_id.localeCompare(b.character_id, 'en');
		if (c !== 0) return c;
		return a.scene_id.localeCompare(b.scene_id, 'en');
	});

	return {
		scenes_drawable: drawableScenes,
		appearance_events: { appearances },
		appearance_states: stateStore
	};
}

function buildCanonicalIndex(canonical: CanonicalCharactersArtifact): CanonicalIndex {
	const drawableIds = new Set<string>();
	const chars = canonical && typeof canonical === 'object' && canonical.characters && typeof canonical.characters === 'object'
		? canonical.characters
		: {};

	for (const [key, value] of Object.entries(chars)) {
		if (!value || typeof value !== 'object') continue;
		const v = value as any;
		const id = typeof v.character_id === 'string' && v.character_id.trim().length > 0 ? v.character_id.trim() : key;
		if (v.drawable === true) drawableIds.add(id);
	}

	return { drawableIds };
}

function buildDrawableSceneIdSet(classified: ClassifiedScenesArtifact): Set<string> {
	const set = new Set<string>();
	const scenes = Array.isArray(classified?.scenes) ? classified.scenes : [];
	for (const s of scenes) {
		if (s && typeof s.scene_id === 'string' && s.drawable === true) set.add(s.scene_id);
	}
	return set;
}

function selectDrawableScenes(pov: ScenesArtifact, drawableSceneIds: Set<string>): ScenesArtifact {
	const inScenes = Array.isArray(pov?.scenes) ? pov.scenes : [];
	const scenes = inScenes.filter((s) => s && typeof s.scene_id === 'string' && drawableSceneIds.has(s.scene_id));
	return { scenes };
}

function sanitizeExistingStates(existing: unknown): AppearanceStatesFile {
	if (!existing || typeof existing !== 'object') return {};
	const out: AppearanceStatesFile = {};
	for (const [cid, list] of Object.entries(existing as Record<string, unknown>)) {
		if (!Array.isArray(list)) continue;
		out[cid] = list
			.filter((x) => x && typeof x === 'object')
			.map((x: any) => ({
				state_id: typeof x.state_id === 'string' ? x.state_id : '',
				traits: sanitizeTraits(x.traits),
				confidence: sanitizeConfidence(x.confidence)
			}))
			.filter((x) => x.state_id.length > 0);
	}
	return out;
}

function sanitizeTraits(value: unknown): AppearanceTraits {
	const v = value && typeof value === 'object' ? (value as any) : {};
	return {
		clothing: typeof v.clothing === 'string' && v.clothing.trim() ? v.clothing.trim() : null,
		hair: typeof v.hair === 'string' && v.hair.trim() ? v.hair.trim() : null,
		condition: typeof v.condition === 'string' && v.condition.trim() ? v.condition.trim() : null,
		notes: Array.isArray(v.notes) ? v.notes.filter((n: unknown) => typeof n === 'string').map((n: string) => n.trim()).filter(Boolean) : []
	};
}

function sanitizeConfidence(v: unknown): Confidence {
	return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}

function ensureBaselineStates(stateStore: AppearanceStatesFile, index: CanonicalIndex): void {
	for (const id of index.drawableIds) {
		const list = stateStore[id] ?? [];
		if (list.length > 0) {
			stateStore[id] = list;
			continue;
		}
		stateStore[id] = [
			{
				state_id: makeStateId(id, 1),
				traits: { clothing: null, hair: null, condition: null, notes: [] },
				confidence: 'low'
			}
		];
	}
}

function getDrawableParticipants(scene: ScenesArtifact['scenes'][number], index: CanonicalIndex): string[] {
	const set = new Set<string>();
	const chars = Array.isArray(scene?.characters_present) ? scene.characters_present : [];
	for (const c of chars) {
		if (typeof c !== 'string') continue;
		const id = c.trim();
		if (index.drawableIds.has(id)) set.add(id);
	}
	const actions = Array.isArray(scene?.actions) ? scene.actions : [];
	for (const a of actions) {
		const cid = typeof a?.character_id === 'string' ? a.character_id.trim() : '';
		if (cid && index.drawableIds.has(cid)) set.add(cid);
	}
	const out = Array.from(set);
	out.sort((a, b) => a.localeCompare(b, 'en'));
	return out;
}

function detectForCharacterInScene(
	characterId: string,
	scene: ScenesArtifact['scenes'][number],
	stateStore: AppearanceStatesFile
): AppearanceEvent | null {
	const sceneId = typeof scene?.scene_id === 'string' ? scene.scene_id : '';
	if (!sceneId) return null;

	const prev = getLatestState(stateStore, characterId);
	if (!prev) return null;

	const evidence = extractTraitsFromScene(characterId, scene);
	const next = computeNextState(characterId, prev, evidence, stateStore);
	if (!next) return null;

	return {
		character_id: characterId,
		scene_id: sceneId,
		appearance_state: next
	};
}

function getLatestState(stateStore: AppearanceStatesFile, characterId: string): { state_id: string; traits: AppearanceTraits; confidence: Confidence } | null {
	const list = stateStore[characterId] ?? [];
	if (!list.length) return null;
	return list.at(-1) ?? null;
}

function computeNextState(
	characterId: string,
	prev: { state_id: string; traits: AppearanceTraits; confidence: Confidence },
	evidence: { traits: Partial<AppearanceTraits>; confidence: Confidence },
	stateStore: AppearanceStatesFile
): AppearanceState | null {
	const extracted = normalizeExtractedTraits(evidence.traits);
	const isChange = hasMeaningfulChange(prev.traits, extracted);
	if (!isChange) {
		return {
			state_id: prev.state_id,
			is_new_state: false,
			derived_from_state_id: prev.state_id,
			traits: prev.traits,
			confidence: 'low'
		};
	}

	const nextTraits = mergeTraits(prev.traits, extracted);
	const nextIndex = (stateStore[characterId]?.length ?? 0) + 1;
	const nextId = makeStateId(characterId, nextIndex);

	// Persist new state.
	const list = stateStore[characterId] ?? [];
	list.push({ state_id: nextId, traits: nextTraits, confidence: evidence.confidence });
	stateStore[characterId] = list;

	return {
		state_id: nextId,
		is_new_state: true,
		derived_from_state_id: prev.state_id,
		traits: nextTraits,
		confidence: evidence.confidence
	};
}

function normalizeExtractedTraits(partial: Partial<AppearanceTraits>): AppearanceTraits {
	const notes = Array.isArray(partial.notes) ? partial.notes : [];
	return {
		clothing: typeof partial.clothing === 'string' && partial.clothing.trim() ? collapseWs(partial.clothing) : null,
		hair: typeof partial.hair === 'string' && partial.hair.trim() ? collapseWs(partial.hair) : null,
		condition: typeof partial.condition === 'string' && partial.condition.trim() ? collapseWs(partial.condition) : null,
		notes: notes.map((n) => collapseWs(String(n))).filter(Boolean)
	};
}

function hasMeaningfulChange(prev: AppearanceTraits, extracted: AppearanceTraits): boolean {
	if (extracted.clothing && !sameTrait(prev.clothing, extracted.clothing)) return true;
	if (extracted.hair && !sameTrait(prev.hair, extracted.hair)) return true;
	if (extracted.condition && !sameTrait(prev.condition, extracted.condition)) return true;
	if (extracted.notes.length > 0) return true;
	return false;
}

function sameTrait(a: string | null, b: string | null): boolean {
	const na = a ? normalizeName(a) : '';
	const nb = b ? normalizeName(b) : '';
	return na === nb;
}

function mergeTraits(prev: AppearanceTraits, extracted: AppearanceTraits): AppearanceTraits {
	return {
		clothing: extracted.clothing ?? prev.clothing,
		hair: extracted.hair ?? prev.hair,
		condition: extracted.condition ?? prev.condition,
		notes: mergeNotes(prev.notes, extracted.notes)
	};
}

function mergeNotes(prev: string[], extra: string[]): string[] {
	const combined = [...(prev ?? []), ...(extra ?? [])].map((s) => collapseWs(String(s))).filter(Boolean);
	const uniq = Array.from(new Set(combined));
	uniq.sort((a, b) => a.localeCompare(b, 'en'));
	return uniq;
}

function extractTraitsFromScene(
	characterId: string,
	scene: ScenesArtifact['scenes'][number]
): { traits: Partial<AppearanceTraits>; confidence: Confidence } {
	const actions = Array.isArray(scene?.actions) ? scene.actions : [];
	const relevant = actions
		.filter((a) => typeof a?.character_id === 'string' && a.character_id.trim() === characterId)
		.map((a) => (typeof a?.action === 'string' ? a.action : ''))
		.map((t) => collapseWs(t))
		.filter(Boolean);

	let clothing: string | null = null;
	let hair: string | null = null;
	let condition: string | null = null;

	let strength: Confidence = 'low';
	for (const text of relevant) {
		const c: string | null = clothing ?? extractClothing(text);
		const h: string | null = hair ?? extractHair(text);
		const cond: string | null = condition ?? extractCondition(text);

		clothing = c;
		hair = h;
		condition = cond;

		strength = maxConfidence(strength, inferConfidence(text, { clothing: c, hair: h, condition: cond }));
	}

	return {
		traits: { clothing, hair, condition, notes: [] },
		confidence: strength
	};
}

function inferConfidence(text: string, extracted: { clothing: string | null; hair: string | null; condition: string | null }): Confidence {
	const t = text.toLowerCase();
	if (extracted.clothing && /\b(wore|wearing|was\s+dressed\s+in|dressed\s+in|put\s+on|donned)\b/.test(t)) return 'high';
	if (extracted.hair && /\bhair\b\s+(was|were|is)\b/.test(t)) return 'high';
	if (extracted.condition && (new RegExp(String.raw`\b(${CONDITION_WORDS.join('|')})\b`).test(t) || /\bcovered\s+in\b/.test(t))) return 'high';

	if (extracted.clothing && /\bin\s+(a|an|the)\b/.test(t)) return 'medium';
	if (extracted.hair && /\bwith\b/.test(t)) return 'medium';
	if (extracted.condition) return 'medium';
	return 'low';
}

function maxConfidence(a: Confidence, b: Confidence): Confidence {
	if (a === 'high' || b === 'high') return 'high';
	if (a === 'medium' || b === 'medium') return 'medium';
	return 'low';
}

function extractClothing(text: string): string | null {
	const t = String(text ?? '').trim();
	if (!t) return null;
	const lower = t.toLowerCase();

	const wear = matchGroup(lower, /\b(?:wore|wearing|put\s+on|donned)\b\s+(?:a|an|the)?\s*([^.;,]+)/i);
	if (wear) return collapseWs(wear);

	const dressed = matchGroup(lower, /\b(?:was\s+dressed\s+in|dressed\s+in)\b\s+(?:a|an|the)?\s*([^.;,]+)/i);
	if (dressed) return collapseWs(dressed);

	const clothesWere = matchGroup(lower, /\b(?:clothes|clothing|garments)\b\s+(?:were|was)\s+([^.;,]+)/i);
	if (clothesWere) return collapseWs(`clothes were ${clothesWere}`);

	const garment = matchGarmentPhrase(lower);
	if (garment) return collapseWs(garment);

	return null;
}

function matchGarmentPhrase(lower: string): string | null {
	for (const g of GARMENT_WORDS) {
		const re = new RegExp(String.raw`\bin\s+(?:a|an|the)\s+(${escapeRegex(g)}[^.;,]*)`, 'i');
		const m = re.exec(lower);
		if (m?.[1]) return m[1];
	}
	return null;
}

function extractHair(text: string): string | null {
	const t = String(text ?? '').trim();
	if (!t) return null;
	const lower = t.toLowerCase();

	const hairWas = matchGroup(lower, /\bhair\b\s+(?:was|were|is)\s+([^.;,]+)/i);
	if (hairWas) return collapseWs(hairWas);

	const withHair = matchGroup(lower, /\bwith\s+([^.;,]+?)\s+hair\b/i);
	if (withHair) return collapseWs(withHair);

	return null;
}

function extractCondition(text: string): string | null {
	const t = String(text ?? '').trim();
	if (!t) return null;
	const lower = t.toLowerCase();

	const covered = matchGroup(lower, /\bcovered\s+in\s+([^.;,]+)/i);
	if (covered) return collapseWs(`covered in ${covered}`);

	const condWord = matchConditionWord(lower);
	if (condWord) return condWord;

	const wasAdj = matchGroup(lower, /\b(?:was|were|looked|seemed)\s+([^.;,]+)/i);
	if (wasAdj) {
		for (const w of CONDITION_WORDS) {
			if (new RegExp(String.raw`\b${escapeRegex(w)}\b`, 'i').test(wasAdj)) return w;
		}
	}

	return null;
}

function matchConditionWord(lower: string): string | null {
	for (const w of CONDITION_WORDS) {
		const re = new RegExp(String.raw`\b${escapeRegex(w)}\b`, 'i');
		if (re.test(lower)) return w;
	}
	return null;
}

function matchGroup(text: string, re: RegExp): string | null {
	const m = re.exec(text);
	if (!m?.[1]) return null;
	return String(m[1]).trim();
}

function makeStateId(characterId: string, index1Based: number): string {
	const base = normalizeName(characterId).replaceAll(' ', '_');
	return `${base}_state_${String(index1Based).padStart(3, '0')}`;
}

function collapseWs(s: string): string {
	return String(s ?? '').trim().replaceAll(/\s+/g, ' ');
}

function escapeRegex(s: string): string {
	return String(s).replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function getSceneOrder(drawableScenes: ScenesArtifact, sceneId: string): number {
	const scenes = drawableScenes.scenes;
	for (const s of scenes) {
		if (s.scene_id === sceneId) return s.order;
	}
	return 0;
}
