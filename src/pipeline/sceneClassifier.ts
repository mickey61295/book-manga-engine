export type SceneKind =
	| 'visual_scene'
	| 'dialogue_scene'
	| 'narration_only'
	| 'epistolary'
	| 'background_exposition'
	| 'unknown';

export interface ClassifiedScene {
	scene_id: string;
	order: number;
	kind: SceneKind;
	drawable: boolean;
	reason: string;
}

export interface ScenesPovResolvedArtifact {
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

export function classifyScenesForVisualGating(input: ScenesPovResolvedArtifact): { scenes: ClassifiedScene[] } {
	const scenes = Array.isArray(input?.scenes) ? input.scenes : [];

	// Do NOT reorder: preserve existing order and only map.
	const out: ClassifiedScene[] = scenes.map((s) => classifyOne(s));
	return { scenes: out };
}

function classifyOne(scene: any): ClassifiedScene {
	const scene_id = typeof scene?.scene_id === 'string' ? scene.scene_id : '';
	const order = typeof scene?.order === 'number' ? scene.order : 0;

	const characters_present = Array.isArray(scene?.characters_present)
		? scene.characters_present.filter((x: unknown) => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean)
		: [];
	const actions = Array.isArray(scene?.actions)
		? scene.actions
				.filter((a: unknown) => a !== null && typeof a === 'object')
				.map((a: any) => ({
					character_id: typeof a.character_id === 'string' ? a.character_id.trim() : '',
					action: typeof a.action === 'string' ? a.action.trim() : ''
				}))
				.filter((a: { character_id: string; action: string }) => a.character_id.length > 0 && a.action.length > 0)
		: [];

	const hasCharacters = characters_present.length > 0;
	const hasActions = actions.length > 0;

	const textBlob = buildTextBlob(scene, characters_present, actions);
	const scores = scoreScene(textBlob, actions, characters_present);

	const classification = classifyKindAndReason({ hasActions, hasCharacters }, scores);
	const kind = classification.kind;
	const reason = classification.reason;

	const drawable = kind === 'visual_scene' || kind === 'dialogue_scene';

	return {
		scene_id,
		order,
		kind,
		drawable,
		reason
	};
}

function classifyKindAndReason(
	flags: { hasActions: boolean; hasCharacters: boolean },
	scores: {
		dialogueScore: number;
		physicalScore: number;
		narrationScore: number;
		coPresence: boolean;
		epistolaryStrong: boolean;
		epistolaryWeak: boolean;
		epistolaryReason: string;
	}
): { kind: SceneKind; reason: string } {
	// Epistolary first: safest non-drawable classification.
	if (scores.epistolaryStrong) {
		return { kind: 'epistolary', reason: scores.epistolaryReason };
	}

	if (flags.hasActions) {
		if (scores.dialogueScore > 0 && scores.coPresence) {
			return { kind: 'dialogue_scene', reason: 'Contains dialogue-attribution actions with multiple characters present.' };
		}
		if (scores.physicalScore > 0 && flags.hasCharacters) {
			return { kind: 'visual_scene', reason: 'Contains concrete, present-time actions attributable to characters.' };
		}
		if (scores.narrationScore > 0 && scores.physicalScore === 0 && scores.dialogueScore === 0) {
			return {
				kind: 'narration_only',
				reason: 'Actions are primarily reflective/intention/mental-state rather than physical events.'
			};
		}
		return { kind: 'unknown', reason: 'Insufficient evidence to safely classify scene type.' };
	}

	// No actions: we cannot safely assume a drawable event.
	if (scores.epistolaryWeak) {
		return { kind: 'epistolary', reason: scores.epistolaryReason };
	}
	if (!flags.hasCharacters) {
		return { kind: 'background_exposition', reason: 'No actions and no focal characters present.' };
	}
	return { kind: 'unknown', reason: 'Insufficient evidence (no actions) to classify as drawable.' };
}

function buildTextBlob(
	scene: any,
	characters_present: string[],
	actions: Array<{ character_id: string; action: string }>
): string {
	const parts: string[] = [];
	if (typeof scene?.location === 'string' && scene.location.trim()) parts.push(`location:${scene.location}`);
	if (typeof scene?.time === 'string' && scene.time.trim()) parts.push(`time:${scene.time}`);
	if (characters_present.length) parts.push(`chars:${characters_present.join(',')}`);
	if (actions.length) parts.push(`actions:${actions.map((a) => a.action).join(' | ')}`);
	return parts.join('\n');
}

function scoreScene(
	textBlob: string,
	actions: Array<{ character_id: string; action: string }>,
	characters_present: string[]
): {
	dialogueScore: number;
	physicalScore: number;
	narrationScore: number;
	coPresence: boolean;
	epistolaryStrong: boolean;
	epistolaryWeak: boolean;
	epistolaryReason: string;
} {
	const t = textBlob.toLowerCase();
	const coPresence = new Set(characters_present).size >= 2;

	const dialogueScore = countRegexHits(t, /\b(said|asked|replied|answered|told|whispered|shouted|exclaimed|cried|remarked|murmured|called)\b/g);

	const physicalScore = countRegexHits(
		t,
		/\b(arrived|entered|left|went|walked|ran|rode|sat|stood|opened|closed|took|put|looked|turned|came|returned|followed|met|found|saw)\b/g
	);

	const narrationScore = countTokenHits(t, [
		'thought',
		'think',
		'felt',
		'feel',
		'believed',
		'believe',
		'hoped',
		'hope',
		'feared',
		'fear',
		'wished',
		'wish',
		'remembered',
		'remember',
		'resolved',
		'resolve',
		'intended',
		'intend',
		'planned',
		'plan',
		'decided',
		'decide',
		'considered',
		'consider'
	]);

	const epistolaryStrong = countTokenHits(t, ['letter', 'letters', 'journal', 'diary', 'write', 'wrote', 'written', 'dear']) > 0;
	const epistolaryWeak = looksLikeDateHeader(t) && (actions.length === 0 || narrationScore > 0);
	const epistolaryReason = epistolaryStrong
		? 'Scene indicates written/letter/journal framing rather than physical co-presence.'
		: 'Scene appears to be dated/epistolary framing and lacks concrete physical action.';

	return {
		dialogueScore,
		physicalScore,
		narrationScore,
		coPresence,
		epistolaryStrong,
		epistolaryWeak,
		epistolaryReason
	};
}

function countRegexHits(text: string, re: RegExp): number {
	if (!text) return 0;
	let n = 0;
	while (re.exec(text) !== null) n += 1;
	return n;
}

function countTokenHits(text: string, tokens: string[]): number {
	let n = 0;
	for (const tok of tokens) {
		if (!tok) continue;
		const re = new RegExp(String.raw`\b${escapeRegex(tok)}\b`, 'g');
		n += countRegexHits(text, re);
	}
	return n;
}

function escapeRegex(s: string): string {
	return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function looksLikeDateHeader(t: string): boolean {
	// Conservative: month names or day+month patterns.
	if (monthNameHit(t)) return true;
	if (/\b\d{1,2}(st|nd|rd|th)?\b.*\b\d{4}\b/.test(t)) return true;
	return false;
}

function monthNameHit(t: string): boolean {
	return countTokenHits(t, [
		'jan',
		'january',
		'feb',
		'february',
		'mar',
		'march',
		'apr',
		'april',
		'may',
		'jun',
		'june',
		'jul',
		'july',
		'aug',
		'august',
		'sep',
		'september',
		'oct',
		'october',
		'nov',
		'november',
		'dec',
		'december'
	]) > 0;
}
