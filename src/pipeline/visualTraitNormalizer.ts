import * as vscode from 'vscode';
import { parseFirstJsonObject } from '../utils/validation';

export interface NormalizedVisualTraits {
	physical_description: string[];
}

export interface VisualTraitNormalizationInput {
	character_id: string;
	canonical_descriptions: string[];
	rules: {
		allowed: string[];
		forbidden: string[];
	};
}

const SYSTEM_PROMPT = `You are a normalization engine.

Your task is to rewrite existing character descriptions into neutral,
literal, physical visual traits suitable for a reference image.

Rules:
- Do not invent traits
- Do not add emotion, mood, or style
- Do not include lighting or camera language
- Do not output prose
- Output JSON only
- Use simple, factual language`;

// Extra safety guardrails. If these appear, discard model output.
const FORBIDDEN_TOKENS = [
	'anime',
	'manga',
	'cinematic',
	'film',
	'movie',
	'camera',
	'lens',
	'angle',
	'close-up',
	'closeup',
	'wide shot',
	'medium shot',
	'lighting',
	'lit',
	'shadow',
	'mood',
	'emotion',
	'style',
	'stylized',
	'genre',
	'fantasy',
	'sci-fi',
	'scifi',
	'cyberpunk'
];

export async function normalizeCharacterVisualTraits(
	input: VisualTraitNormalizationInput,
	model: vscode.LanguageModelChat,
	token?: vscode.CancellationToken
): Promise<NormalizedVisualTraits> {
	const safeInput = sanitizeInput(input);
	if (safeInput.canonical_descriptions.length === 0) {
		// Empty-evidence fallback: skip LLM.
		return { physical_description: [] };
	}

	const responseText = await callModel(model, safeInput, token);
	const parsed = parseFirstJsonObject(responseText);
	if (!validateNormalizedVisualTraits(parsed)) {
		return { physical_description: [] };
	}

	const normalized = normalizeTraits(parsed);
	if (containsForbidden(normalized.physical_description)) {
		return { physical_description: [] };
	}

	return normalized;
}

export function containsForbidden(lines: string[]): boolean {
	const joined = lines.map((s) => String(s ?? '').toLowerCase()).join('\n');
	return FORBIDDEN_TOKENS.some((t) => joined.includes(t));
}

async function callModel(
	model: vscode.LanguageModelChat,
	input: VisualTraitNormalizationInput,
	token?: vscode.CancellationToken
): Promise<string> {
	// The model must never see the final prompt. It only sees structured evidence + constraints.
	const user = [
		`You will receive one JSON object representing a single character evidence record and constraints.`,
		`Rewrite ONLY the provided evidence into neutral physical traits.`,
		`Do not add anything new.`,
		`Return ONLY JSON matching exactly:`,
		`{`,
		`  "physical_description": string[]`,
		`}`,
		``,
		`Input JSON:`,
		JSON.stringify(input)
	].join('\n');

	const content = `${SYSTEM_PROMPT}\n\n${user}`;
	const messages = [vscode.LanguageModelChatMessage.User(content)];

	const response = await model.sendRequest(
		messages,
		{
			justification: 'Normalize character physical traits for reference image prompt assembly.',
			modelOptions: {
				// Determinism: no creative variation.
				temperature: 0
			}
		},
		token
	);

	let out = '';
	for await (const chunk of response.text) out += chunk;
	return out;
}

function validateNormalizedVisualTraits(value: unknown): value is NormalizedVisualTraits {
	if (!value || typeof value !== 'object') return false;
	const v = value as any;
	if (!Array.isArray(v.physical_description)) return false;
	if (!v.physical_description.every((s: any) => typeof s === 'string')) return false;
	return true;
}

function normalizeTraits(value: NormalizedVisualTraits): NormalizedVisualTraits {
	const cleaned = value.physical_description
		.map((s) => collapseWs(String(s)))
		.filter((s) => s.length > 0)
		.map((s) => s.replaceAll(/^[-*•\s]+/g, '').trim())
		.filter((s) => s.length > 0)
		.slice(0, 12);

	const uniq = Array.from(new Set(cleaned));
	return { physical_description: uniq };
}

function sanitizeInput(input: VisualTraitNormalizationInput): VisualTraitNormalizationInput {
	const character_id = collapseWs(String(input?.character_id ?? ''));
	const canonical_descriptions = Array.isArray(input?.canonical_descriptions)
		? input.canonical_descriptions.map((s) => collapseWs(String(s))).filter(Boolean)
		: [];

	const rulesAllowed = Array.isArray(input?.rules?.allowed)
		? input.rules.allowed.map((s) => collapseWs(String(s))).filter(Boolean)
		: [];
	const rulesForbidden = Array.isArray(input?.rules?.forbidden)
		? input.rules.forbidden.map((s) => collapseWs(String(s))).filter(Boolean)
		: [];

	return {
		character_id,
		canonical_descriptions: canonical_descriptions.slice(0, 40),
		rules: {
			allowed: rulesAllowed.slice(0, 40),
			forbidden: rulesForbidden.slice(0, 80)
		}
	};
}

function collapseWs(s: string): string {
	return String(s ?? '').trim().replaceAll(/\s+/g, ' ');
}
