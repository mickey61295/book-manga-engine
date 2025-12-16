export type PanelFraming = 'wide' | 'medium' | 'close';
export type PanelFocus = 'environment' | 'character' | 'interaction';

export interface DrawableScene {
	scene_id: string;
	order: number;
	location: string | null;
	time: string | null;
	characters_present: string[];
	actions: Array<{ character_id: string; action: string }>;
}

export interface ScenesDrawableArtifact {
	scenes: DrawableScene[];
}

export interface AppearanceEventsArtifact {
	appearances: Array<{
		character_id: string;
		scene_id: string;
		appearance_state: { state_id: string };
	}>;
}

export interface Panel {
	scene_id: string;
	panel_id: string;
	order: number;
	characters_present: string[];
	primary_action: string;
	framing: PanelFraming;
	focus: PanelFocus;
	notes: string[];
}

export interface PanelsArtifact {
	panels: Panel[];
}

interface PanelGroup {
	scene_id: string;
	order: number;
	characterIds: string[];
	actions: string[];
}

const DIALOGUE_HINTS = [
	'said',
	'asked',
	'replied',
	'addressed',
	'told',
	'shouted',
	'whispered',
	'spoke',
	'yelled',
	'cried',
	'murmured',
	'answered'
];

const MOVEMENT_HINTS = [
	'walk',
	'walked',
	'run',
	'ran',
	'move',
	'moved',
	'passed',
	'approached',
	'approach',
	'entered',
	'enter',
	'left',
	'leave',
	'came',
	'went',
	'drifted',
	'travel',
	'travelled',
	'rode',
	'crossed'
];

const CONTINUOUS_HINTS = ['sat', 'stood', 'guided', 'held', 'kept', 'stayed', 'waited', 'watched', 'looked'];

export function segmentScenesToPanels(params: {
	scenesDrawable: ScenesDrawableArtifact;
	appearanceEvents?: AppearanceEventsArtifact;
}): PanelsArtifact {
	const scenes = Array.isArray(params.scenesDrawable?.scenes) ? params.scenesDrawable.scenes : [];
	// Appearance events are read-only context for continuity (not serialized into panel schema today).
	const appearanceIndex = indexAppearanceEvents(params.appearanceEvents);

	const sortedScenes = [...scenes].sort((a, b) => {
		const ao = typeof a?.order === 'number' ? a.order : 0;
		const bo = typeof b?.order === 'number' ? b.order : 0;
		if (ao !== bo) return ao - bo;
		return String(a?.scene_id ?? '').localeCompare(String(b?.scene_id ?? ''), 'en');
	});

	const panels: Panel[] = [];
	for (const scene of sortedScenes) {
		if (!scene || typeof scene.scene_id !== 'string') continue;
		const scenePanels = segmentOneScene(scene, appearanceIndex);
		panels.push(...scenePanels);
	}

	return { panels };
}

function indexAppearanceEvents(events?: AppearanceEventsArtifact): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	if (!events || !Array.isArray(events.appearances)) return map;
	const appearances = events.appearances;
	for (const a of appearances) {
		if (!a || typeof a.scene_id !== 'string' || typeof a.character_id !== 'string') continue;
		const key = a.scene_id;
		const set = map.get(key) ?? new Set<string>();
		set.add(a.character_id);
		map.set(key, set);
	}
	return map;
}

function segmentOneScene(scene: DrawableScene, appearanceIndex: Map<string, Set<string>>): Panel[] {
	const sceneId = scene.scene_id;
	const actions = Array.isArray(scene.actions) ? scene.actions : [];
	if (actions.length === 0) return [];

	const groups: PanelGroup[] = [];
	for (const item of actions) {
		const cid = typeof item?.character_id === 'string' ? item.character_id.trim() : '';
		const actionText = collapseWs(typeof item?.action === 'string' ? item.action : '');
		if (!cid || !actionText) continue;

		const prev = groups.at(-1);
		if (prev && canMergeInto(prev, { character_id: cid, action: actionText })) {
			prev.actions.push(actionText);
			continue;
		}

		groups.push({ scene_id: sceneId, order: scene.order, characterIds: [cid], actions: [actionText] });
	}

	const panels: Panel[] = [];
	for (let i = 0; i < groups.length; i++) {
		const g = groups[i];
		const primaryAction = joinActions(g.actions);
		if (!primaryAction) continue;

		const characters = stableUniqueSortedCharacters(g.characterIds);
		const { framing, focus, notes } = choosePresentation({
			scene,
			group: g,
			groupIndex: i,
			groupCount: groups.length
		});

		panels.push({
			scene_id: sceneId,
			panel_id: makePanelId(sceneId, i + 1),
			order: i + 1,
			characters_present: characters,
			primary_action: primaryAction,
			framing,
			focus,
			notes
		});
	}

	return panels;
}

function canMergeInto(prev: PanelGroup, next: { character_id: string; action: string }): boolean {
	// Conservative merge rules: only same single character, only a small number of actions per panel,
	// and only when actions look visually continuous/simultaneous.
	if (prev.characterIds.length !== 1) return false;
	if (prev.characterIds[0] !== next.character_id) return false;
	if (prev.actions.length >= 2) return false;

	const prevText = prev.actions.at(-1) ?? '';
	const nextText = next.action;
	if (!prevText || !nextText) return false;

	if (isDialogueLike(prevText) || isDialogueLike(nextText)) return false;

	// If there are explicit sequencing markers, avoid merging.
	if (hasSequencingMarker(prevText) || hasSequencingMarker(nextText)) return false;

	// Prefer merging only when both look continuous, OR when one is a continuous action
	// and the other is a travel-continuation action that can plausibly be simultaneous.
	const prevContinuous = isContinuousLike(prevText);
	const nextContinuous = isContinuousLike(nextText);
	if (prevContinuous && nextContinuous) return true;

	const prevTravel = isTravelContinuationLike(prevText);
	const nextTravel = isTravelContinuationLike(nextText);
	return (prevContinuous && nextTravel) || (nextContinuous && prevTravel);
}

function isTravelContinuationLike(text: string): boolean {
	const t = String(text ?? '').toLowerCase();
	return (
		t.includes('passed on') ||
		t.includes('passed towards') ||
		t.includes('passed to') ||
		t.includes('moved on') ||
		t.includes('went on') ||
		t.includes('continued') ||
		t.includes('proceeded') ||
		t.includes('travelled') ||
		t.includes('traveled') ||
		t.includes('rode on')
	);
}

function choosePresentation(params: {
	scene: DrawableScene;
	group: PanelGroup;
	groupIndex: number;
	groupCount: number;
}): { framing: PanelFraming; focus: PanelFocus; notes: string[] } {
	const action = joinActions(params.group.actions);
	const mergedNotes = params.group.actions.length > 1 ? ['merged consecutive simultaneous actions'] : [];

	if (isDialogueLike(action)) return { framing: 'close', focus: 'interaction', notes: mergedNotes };

	if (isEstablishingPanel(params.scene, params.groupIndex)) {
		return { framing: 'wide', focus: 'environment', notes: [...mergedNotes, 'establish setting'] };
	}

	if (isMovementLike(action)) {
		return { framing: 'wide', focus: params.scene.location ? 'environment' : 'character', notes: mergedNotes };
	}

	if (params.group.characterIds.length >= 2) return { framing: 'medium', focus: 'interaction', notes: mergedNotes };
	return { framing: 'medium', focus: 'character', notes: mergedNotes };
}

function isEstablishingPanel(scene: DrawableScene, groupIndex: number): boolean {
	return groupIndex === 0 && !!(scene.location || scene.time);
}

function stableUniqueSortedCharacters(characterIds: string[]): string[] {
	const set = new Set<string>();
	for (const c of characterIds) {
		if (typeof c !== 'string') continue;
		const id = c.trim();
		if (!id) continue;
		set.add(id);
	}
	const out = Array.from(set);
	out.sort((a, b) => a.localeCompare(b, 'en'));
	return out;
}

function joinActions(actions: string[]): string {
	const cleaned = (actions ?? []).map((a) => collapseWs(a)).filter(Boolean);
	if (cleaned.length === 0) return '';
	if (cleaned.length === 1) return cleaned[0];
	// Deterministic join; do not invent content.
	return `${cleaned[0]} and ${cleaned[1]}`;
}

function isDialogueLike(text: string): boolean {
	const t = String(text ?? '').toLowerCase();
	return DIALOGUE_HINTS.some((w) => t.includes(w));
}

function isMovementLike(text: string): boolean {
	const t = String(text ?? '').toLowerCase();
	return MOVEMENT_HINTS.some((w) => t.includes(w));
}

function isContinuousLike(text: string): boolean {
	const t = String(text ?? '').toLowerCase();
	return CONTINUOUS_HINTS.some((w) => t.includes(w));
}

function hasSequencingMarker(text: string): boolean {
	const t = ` ${String(text ?? '').toLowerCase()} `;
	return (
		t.includes(' then ') ||
		t.includes(' after ') ||
		t.includes(' before ') ||
		t.includes(' suddenly ') ||
		t.includes(' later ') ||
		t.includes(' meanwhile ')
	);
}

function makePanelId(sceneId: string, order1Based: number): string {
	return `${sceneId}_panel_${String(order1Based).padStart(2, '0')}`;
}

function collapseWs(s: string): string {
	return String(s ?? '').trim().replaceAll(/\s+/g, ' ');
}

function isNonEmpty(v: string | null): v is string {
	return typeof v === 'string' && v.trim().length > 0;
}
