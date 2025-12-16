import * as vscode from 'vscode';
import { retryWithBackoff } from '../utils/retry';
import { parseFirstJsonObject } from '../utils/validation';

export interface SceneAction {
	character_id: string;
	action: string;
}

export interface SceneFragment {
	scene_id: string;
	order_hint: number;
	location: string | null;
	time: string | null;
	characters_present: string[];
	actions: SceneAction[];
	source_chunks: number[];
}

export interface ChunkScenesResult {
	chunkIndex: number;
	scenes: SceneFragment[];
}

export interface ExtractScenesParams {
	chunkIndex: number;
	text: string;
	model: vscode.LanguageModelChat;
	token?: vscode.CancellationToken;
}

const SYSTEM_RULES = `You are a conservative scene extraction engine.
You MUST only use the provided text chunk.
You MUST NOT invent scenes.
You MUST NOT invent characters.
You MUST NOT make visual decisions.
You MUST output STRICT JSON ONLY (no markdown, no prose).`;

function buildPrompt(chunkIndex: number, text: string): string {
	return [
		`Input (chunk):`,
		JSON.stringify({ chunkIndex, text }),
		``,
		`Task: Extract raw scene fragments from this single chunk.`,
		`IMPORTANT: This is a RAW stage. Do NOT resolve pronouns. Do NOT map aliases.`,
		`Represent characters exactly as they appear in the text (including pronouns like "I", "we", etc.).`,
		`If there are no scenes, return {"scenes": []}.`,
		``,
		`Output format (return ONLY JSON, no markdown):`,
		`{`,
		`  "scenes": [`,
		`    {`,
		`      "scene_id": string,`,
		`      "order_hint": number,`,
		`      "location": string | null,`,
		`      "time": string | null,`,
		`      "characters_present": string[],`,
		`      "actions": [ { "character_id": string, "action": string } ],`,
		`      "source_chunks": number[]`,
		`    }`,
		`  ]`,
		`}`,
		``,
		`Rules:`,
		`- A scene is a continuous narrative segment with stable location/context.`,
		`- Start a new scene ONLY when location changes, time jumps meaningfully, or setting shifts.`,
		`- Do NOT split for minor actions or dialogue alone.`,
		`- location/time: ONLY if explicit; otherwise null. Never guess.`,
		`- actions: factual, attributable to ONE character_id string from the text (raw mention), copied or lightly normalized from text. No summaries.`,
		`- characters_present: include raw character strings explicitly present or acting in this chunk.`,
		`- source_chunks MUST be [${chunkIndex}].`,
		`- scene_id/order_hint: You may set placeholders; the caller will overwrite deterministically.`
	].join('\n');
}

export async function extractScenesFromChunk(params: ExtractScenesParams): Promise<ChunkScenesResult> {
	return retryWithBackoff(async () => {
		const raw = await callCopilot(params.model, {
			system: SYSTEM_RULES,
			user: buildPrompt(params.chunkIndex, params.text)
		}, params.token);

		const parsed = parseFirstJsonObject(raw);
		if (!isScenesEnvelope(parsed)) {
			throw new Error('Model output failed scenes schema validation');
		}

		const normalized = normalizeAndFilterScenes(parsed.scenes, {
			chunkIndex: params.chunkIndex
		});

		return {
			chunkIndex: params.chunkIndex,
			scenes: normalized
		};
	}, { retries: 2, baseDelayMs: 700 });
}

async function callCopilot(
	model: vscode.LanguageModelChat,
	prompt: { system: string; user: string },
	token?: vscode.CancellationToken
): Promise<string> {
	const content = `${prompt.system}\n\n${prompt.user}`;
	const messages = [vscode.LanguageModelChatMessage.User(content)];

	const response = await model.sendRequest(
		messages,
		{
			justification: 'Extract raw per-chunk scene fragments for story-to-manga pipeline (no pronoun/alias resolution).',
			modelOptions: {
				temperature: 0
			}
		},
		token
	);

	let out = '';
	for await (const chunk of response.text) out += chunk;
	return out;
}

function isScenesEnvelope(value: unknown): value is { scenes: unknown[] } {
	if (!value || typeof value !== 'object') return false;
	const v = value as any;
	return Array.isArray(v.scenes);
}

function normalizeAndFilterScenes(
	scenes: unknown[],
	ctx: { chunkIndex: number }
): SceneFragment[] {
	const out: SceneFragment[] = [];
	let localIndex = 0;
	for (const raw of scenes) {
		const candidate = parseSceneCandidate(raw);
		if (!candidate) continue;
		const fragment = buildSceneFragment(candidate, ctx, localIndex + 1);
		if (!fragment) continue;
		localIndex += 1;
		out.push(fragment);
	}
	return out;
}

function parseSceneCandidate(value: unknown): {
	location: string | null;
	time: string | null;
	characters_present: string[];
	actions: SceneAction[];
} | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as any;

	const location = typeof v.location === 'string' ? v.location.trim() : null;
	const time = typeof v.time === 'string' ? v.time.trim() : null;

	const characters_present: string[] = Array.isArray(v.characters_present)
		? v.characters_present
				.filter((x: unknown) => typeof x === 'string')
				.map((x: string) => x.trim())
		: [];

	const actions: SceneAction[] = Array.isArray(v.actions)
		? v.actions
				.filter((a: unknown) => a !== null && typeof a === 'object')
				.map((a: any) => ({
					character_id: typeof a.character_id === 'string' ? a.character_id.trim() : '',
					action: typeof a.action === 'string' ? a.action.trim() : ''
				}))
		: [];

	return { location, time, characters_present, actions };
}

function buildSceneFragment(
	candidate: { location: string | null; time: string | null; characters_present: string[]; actions: SceneAction[] },
	ctx: { chunkIndex: number },
	localIndex1Based: number
): SceneFragment | null {
	const filteredCharacters: string[] = Array.from(
		new Set<string>(candidate.characters_present.filter((id: string) => id.length > 0))
	);
	filteredCharacters.sort((a, b) => a.localeCompare(b, 'en'));

	const filteredActions = candidate.actions
		.filter((a) => a.character_id.length > 0 && a.action.length > 0)
		.map((a) => ({ character_id: a.character_id, action: a.action }));

	// Raw stage: keep scenes even if only location/time exists, but drop totally empty scenes.
	if (filteredCharacters.length === 0 && filteredActions.length === 0) {
		const hasLoc = Boolean(candidate.location?.trim().length);
		const hasTime = Boolean(candidate.time?.trim().length);
		if (!hasLoc && !hasTime) return null;
	}

	const location = candidate.location?.length ? candidate.location : null;
	const time = candidate.time?.length ? candidate.time : null;

	return {
		scene_id: `c${ctx.chunkIndex}_s${localIndex1Based}`,
		order_hint: ctx.chunkIndex * 1000 + localIndex1Based,
		location,
		time,
		characters_present: filteredCharacters,
		actions: filteredActions,
		source_chunks: [ctx.chunkIndex]
	};
}

