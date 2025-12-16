import * as vscode from 'vscode';
import { retryWithBackoff } from '../utils/retry';
import { parseFirstJsonObject } from '../utils/validation';
import type { AggregatedCharacter } from './aggregator';

export type CharacterKind =
	| 'narrative_character'
	| 'referenced_human'
	| 'mythological'
	| 'abstract'
	| 'unknown';

export type Confidence = 'high' | 'medium' | 'low';

export interface CanonicalCharacterOutput {
	character_id: string;
	kind: CharacterKind;
	drawable: boolean;
	core_identity:
		| {
				role: string | null;
				gender: string | null;
				age: string | null;
				notes: string[];
		  }
		| null;
	reason: string;
	confidence: Confidence;
}

const SYSTEM_RULES = `You are a conservative narrative classification engine.
You MUST only use the provided evidence.
You MUST be conservative and prefer unknown.
You MUST output STRICT JSON ONLY (no markdown, no prose).`;

function toCharacterId(name: string): string {
	const n = String(name ?? '').toLowerCase().trim();
	// keep letters/numbers/spaces/underscore, then normalize whitespace to underscore
	const cleaned = n.replaceAll(/[^\p{L}\p{N}_\s]+/gu, ' ').replaceAll(/\s+/g, ' ').trim();
	return cleaned.replaceAll(' ', '_');
}

function buildPrompt(input: AggregatedCharacter): string {
	const expectedId = stableCharacterIdFromName(input.canonical_name);
	return [
		`You will be given ONE aggregated character evidence record from a story-processing pipeline.`,
		`You MUST classify it conservatively and decide drawability using the rules below.`,
		`You MUST NOT reason across multiple characters.`,
		`You MUST set character_id to exactly: ${expectedId}`,
		``,
		`Output JSON schema (return ONLY JSON):`,
		`{`,
		`  "character_id": string,`,
		`  "kind": "narrative_character" | "referenced_human" | "mythological" | "abstract" | "unknown",`,
		`  "drawable": boolean,`,
		`  "core_identity": {`,
		`    "role": string | null,`,
		`    "gender": string | null,`,
		`    "age": string | null,`,
		`    "notes": string[]`,
		`  } | null,`,
		`  "reason": string,`,
		`  "confidence": "high" | "medium" | "low"`,
		`}`,
		``,
		`Rules:`,
		`- Base decisions ONLY on provided evidence.`,
		`- Be conservative; "unknown" is allowed.`,
		`- Do NOT invent traits. Do NOT invent physical appearance.`,
		`- Do NOT summarize the story.`,
		`- Drawability: true ONLY if kind is "narrative_character" AND evidence shows acting in scenes (concrete actions). Otherwise false.`,
		`- Mythological: religious/biblical/legendary/symbolic; metaphorical/comparative; never drawn.`,
		`- Abstract: concepts/forces/ideas (e.g., Fate, Nature).`,
		`- referenced_human: mentioned but does not act in scenes; not drawn.`,
		``,
		`Input aggregated record (JSON):`,
		JSON.stringify(input)
	].join('\n');
}

export async function canonicalizeCharacter(
	input: AggregatedCharacter,
	model: vscode.LanguageModelChat,
	token?: vscode.CancellationToken
): Promise<CanonicalCharacterOutput> {
	const expectedId = toCharacterId(input.canonical_name);

	return retryWithBackoff(async () => {
		const responseText = await callCopilot(model, {
			system: SYSTEM_RULES,
			user: buildPrompt(input)
		}, token);

		const parsed = parseFirstJsonObject(responseText);
		if (!validateCanonicalCharacterOutput(parsed)) {
			throw new Error('Model output failed canonical character schema validation');
		}

		// Determinism guard: enforce stable id derived from canonical_name.
		if (parsed.character_id !== expectedId) {
			throw new Error(`Model returned character_id=${parsed.character_id} (expected ${expectedId})`);
		}

		return normalizeCanonicalCharacterOutput(parsed);
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
			justification: 'Classify canonical characters and drawability for a story-to-manga pipeline.',
			modelOptions: {
				// Best-effort: not all models honor this, but it nudges toward determinism.
				temperature: 0
			}
		},
		token
	);

	let out = '';
	for await (const chunk of response.text) out += chunk;
	return out;
}

function validateCanonicalCharacterOutput(value: unknown): value is CanonicalCharacterOutput {
	if (!value || typeof value !== 'object') return false;
	const v = value as any;
	if (typeof v.character_id !== 'string' || v.character_id.trim().length === 0) return false;
	if (!['narrative_character', 'referenced_human', 'mythological', 'abstract', 'unknown'].includes(v.kind)) return false;
	if (typeof v.drawable !== 'boolean') return false;
	if (typeof v.reason !== 'string' || v.reason.trim().length === 0) return false;
	if (!['high', 'medium', 'low'].includes(v.confidence)) return false;

	if (v.core_identity === null) return true;
	if (!v.core_identity || typeof v.core_identity !== 'object') return false;
	if (!('role' in v.core_identity) || !('gender' in v.core_identity) || !('age' in v.core_identity) || !('notes' in v.core_identity)) {
		return false;
	}
	if (!(v.core_identity.role === null || typeof v.core_identity.role === 'string')) return false;
	if (!(v.core_identity.gender === null || typeof v.core_identity.gender === 'string')) return false;
	if (!(v.core_identity.age === null || typeof v.core_identity.age === 'string')) return false;
	if (!Array.isArray(v.core_identity.notes) || !v.core_identity.notes.every((n: any) => typeof n === 'string')) return false;

	return true;
}

function normalizeCanonicalCharacterOutput(out: CanonicalCharacterOutput): CanonicalCharacterOutput {
	const core = out.core_identity
		? {
				role: out.core_identity.role?.trim() ?? null,
				gender: out.core_identity.gender?.trim() ?? null,
				age: out.core_identity.age?.trim() ?? null,
				notes: normalizeStringList(out.core_identity.notes)
		  }
		: null;

	return {
		character_id: out.character_id.trim(),
		kind: out.kind,
		drawable: Boolean(out.drawable),
		core_identity: core,
		reason: out.reason.trim(),
		confidence: out.confidence
	};
}

function normalizeStringList(values: string[]): string[] {
	const cleaned = values
		.map((v) => String(v).trim())
		.filter((v) => v.length > 0);
	const uniq = Array.from(new Set(cleaned));
	uniq.sort((a, b) => a.localeCompare(b, 'en'));
	return uniq;
}

export function stableCharacterIdFromName(canonicalName: string): string {
	return toCharacterId(canonicalName);
}
