import { normalizeName } from './aggregator';

export interface PovSceneAction {
	character_id: string;
	action: string;
}

export interface PovScene {
	scene_id: string;
	order: number;
	location: string | null;
	time: string | null;
	characters_present: string[];
	actions: PovSceneAction[];
	source_chunks: number[];
}

export interface PovScenesArtifact {
	scenes: PovScene[];
}

export interface CanonicalCharactersArtifact {
	characters: Record<string, unknown>;
}

interface CanonicalCharacterInfo {
	character_id: string;
	drawable: boolean;
	role: string | null;
	aliases: string[];
}

interface CanonicalIndex {
	byId: Map<string, CanonicalCharacterInfo>;
	aliasToIds: Map<string, string[]>;
	narratorCandidateIds: string[];
}

const FIRST_PERSON = new Set<string>([
	'i',
	'me',
	'my',
	'mine',
	'myself',
	'we',
	'us',
	'our',
	'ours',
	'ourselves'
]);

const ROLE_NARRATOR_HINT = /(narrat|letter\s*writer|letter\s*writer|writer|story\s*tell|storyteller|diary|journal|memoir)/i;

export function resolveNarratorPov(
	scenesArtifact: PovScenesArtifact,
	canonicalArtifact: CanonicalCharactersArtifact
): PovScenesArtifact {
	const index = buildCanonicalIndex(canonicalArtifact);
	const scenes = Array.isArray(scenesArtifact?.scenes) ? scenesArtifact.scenes.slice() : [];

	// Deterministic ordering by existing order, then stable tie.
	scenes.sort((a, b) => {
		if ((a?.order ?? 0) !== (b?.order ?? 0)) return (a?.order ?? 0) - (b?.order ?? 0);
		return String(a?.scene_id ?? '').localeCompare(String(b?.scene_id ?? ''), 'en');
	});

	let activeNarrator: string | null = null;
	const out: PovScene[] = [];

	for (let i = 0; i < scenes.length; i++) {
		const scene = normalizeSceneInput(scenes[i]);
		const hasFirstPerson = sceneHasFirstPerson(scene);
		if (!hasFirstPerson) {
			activeNarrator = null;
			out.push(scene);
			continue;
		}

		const narrator: string | null = activeNarrator ?? inferNarratorForRun(index, scenes, i);
		if (!narrator) {
			const dropped = dropFirstPerson(scene);
			if (dropped) out.push(dropped);
			activeNarrator = null;
			continue;
		}

		activeNarrator = narrator;
		const resolved = applyNarrator(scene, narrator);
		if (resolved) out.push(resolved);
	}

	return { scenes: out };
}

function normalizeSceneInput(scene: any): PovScene {
	const characters_present = Array.isArray(scene?.characters_present)
		? scene.characters_present.filter((x: unknown) => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean)
		: [];

	const actions: PovSceneAction[] = Array.isArray(scene?.actions)
		? scene.actions
				.filter((a: unknown) => a !== null && typeof a === 'object')
				.map((a: any) => ({
					character_id: typeof a.character_id === 'string' ? a.character_id.trim() : '',
					action: typeof a.action === 'string' ? a.action.trim() : ''
				}))
				.filter((a: PovSceneAction) => a.character_id.length > 0 && a.action.length > 0)
		: [];

	const source_chunks = Array.isArray(scene?.source_chunks)
		? (scene.source_chunks as unknown[])
				.map((n: unknown) => (typeof n === 'number' ? n : Number(n)))
				.filter((n: number) => Number.isFinite(n))
		: [];

	return {
		scene_id: typeof scene?.scene_id === 'string' ? scene.scene_id : '',
		order: typeof scene?.order === 'number' ? scene.order : 0,
		location: typeof scene?.location === 'string' ? scene.location : null,
		time: typeof scene?.time === 'string' ? scene.time : null,
		characters_present,
		actions,
		source_chunks: Array.from(new Set<number>(source_chunks)).sort((a, b) => a - b)
	};
}

function sceneHasFirstPerson(scene: PovScene): boolean {
	for (const c of scene.characters_present) {
		if (isFirstPersonToken(c)) return true;
	}
	for (const a of scene.actions) {
		if (isFirstPersonToken(a.character_id)) return true;
	}
	return false;
}

function isFirstPersonToken(token: string): boolean {
	const t = normalizeName(String(token ?? ''));
	return FIRST_PERSON.has(t);
}

function inferNarratorForRun(index: CanonicalIndex, scenes: any[], i: number): string | null {
	// Conservative: only attempt if exactly one global narrator candidate exists.
	if (index.narratorCandidateIds.length !== 1) return null;
	const candidate = index.narratorCandidateIds[0];

	// Additional conservatism: require candidate presence in a small window around the scene.
	// We only count explicit canonical ID mentions (not alias matching), to avoid guessing.
	const window = getWindowScenes(scenes, i, 2).map((s) => normalizeSceneInput(s));
	const presentCount = window.reduce((acc, s) => acc + countExplicitPresence(s, candidate), 0);
	if (presentCount <= 0) return null;

	return candidate;
}

function getWindowScenes(scenes: any[], i: number, radius: number): any[] {
	const start = Math.max(0, i - radius);
	const end = Math.min(scenes.length - 1, i + radius);
	const out: any[] = [];
	for (let k = start; k <= end; k++) out.push(scenes[k]);
	return out;
}

function countExplicitPresence(scene: PovScene, candidateId: string): number {
	let n = 0;
	for (const c of scene.characters_present) if (c === candidateId) n += 1;
	for (const a of scene.actions) if (a.character_id === candidateId) n += 1;
	return n;
}

function dropFirstPerson(scene: PovScene): PovScene | null {
	const characters_present = scene.characters_present.filter((c) => !isFirstPersonToken(c));
	const actions = scene.actions.filter((a) => !isFirstPersonToken(a.character_id));
	if (characters_present.length === 0 && actions.length === 0) return null;
	return { ...scene, characters_present, actions };
}

function applyNarrator(scene: PovScene, narratorId: string): PovScene | null {
	const characters_present = scene.characters_present.map((c) => (isFirstPersonToken(c) ? narratorId : c));
	const actions = scene.actions.map((a) => ({
		character_id: isFirstPersonToken(a.character_id) ? narratorId : a.character_id,
		action: normalizeActionTextIfStartsWithFirstPerson(a.action)
	}));

	const uniqChars = Array.from(new Set(characters_present.filter(Boolean)));
	uniqChars.sort((a, b) => a.localeCompare(b, 'en'));

	const dedupedActions = dedupeActions(actions);
	if (uniqChars.length === 0 && dedupedActions.length === 0) return null;

	return { ...scene, characters_present: uniqChars, actions: dedupedActions };
}

function normalizeActionTextIfStartsWithFirstPerson(text: string): string {
	let t = String(text ?? '').trim();
	if (!t) return '';
	// Strip leading first-person token only (safe normalization).
	t = t.replace(/^(i|we|me|us|my|our|mine|ours)\b\s+/i, '');
	return t.trim();
}

function dedupeActions(actions: PovSceneAction[]): PovSceneAction[] {
	const out: PovSceneAction[] = [];
	const seen = new Set<string>();
	for (const a of actions) {
		const key = `${a.character_id}|${normalizeName(a.action)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(a);
	}
	return out;
}

function buildCanonicalIndex(canonical: CanonicalCharactersArtifact): CanonicalIndex {
	const byId = new Map<string, CanonicalCharacterInfo>();
	const aliasToIds = new Map<string, string[]>();
	const narratorCandidateIds: string[] = [];

	const chars = getCanonicalCharactersObject(canonical);
	for (const [key, value] of Object.entries(chars)) {
		const info = parseCanonicalCharacter(key, value);
		if (!info) continue;
		byId.set(info.character_id, info);
		if (isNarratorCandidate(info)) narratorCandidateIds.push(info.character_id);
		addAliases(aliasToIds, info.character_id, info.aliases);
	}

	// Determinism.
	narratorCandidateIds.sort((a, b) => a.localeCompare(b, 'en'));
	for (const [aliasKey, ids] of aliasToIds.entries()) {
		const uniq = Array.from(new Set(ids));
		uniq.sort((a, b) => a.localeCompare(b, 'en'));
		aliasToIds.set(aliasKey, uniq);
	}

	return { byId, aliasToIds, narratorCandidateIds };
}

function getCanonicalCharactersObject(canonical: CanonicalCharactersArtifact): Record<string, unknown> {
	if (!canonical || typeof canonical !== 'object') return {};
	const c = (canonical as any).characters;
	if (!c || typeof c !== 'object') return {};
	return c as Record<string, unknown>;
}

function parseCanonicalCharacter(key: string, value: unknown): CanonicalCharacterInfo | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as any;
	const character_id = typeof v.character_id === 'string' && v.character_id.trim().length > 0 ? v.character_id.trim() : key;
	const drawable = Boolean(v.drawable);
	const role = typeof v?.core_identity?.role === 'string' ? String(v.core_identity.role).trim() : null;
	const aliases = normalizeAliases(v.aliases, key, character_id);
	return { character_id, drawable, role, aliases };
}

function normalizeAliases(value: unknown, key: string, characterId: string): string[] {
	const raw = Array.isArray(value) ? value : [];
	const out: string[] = [];
	for (const a of raw) {
		if (typeof a !== 'string') continue;
		const t = a.trim();
		if (t) out.push(t);
	}
	if (key && !out.includes(key)) out.push(key);
	if (characterId && !out.includes(characterId)) out.push(characterId);
	const uniq = Array.from(new Set(out));
	uniq.sort((a, b) => a.localeCompare(b, 'en'));
	return uniq;
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

function isNarratorCandidate(info: CanonicalCharacterInfo): boolean {
	if (!info.drawable) return false;
	if (!info.role) return false;
	return ROLE_NARRATOR_HINT.test(info.role);
}
