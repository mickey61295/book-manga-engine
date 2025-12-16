import * as vscode from 'vscode';
import { retryWithBackoff } from '../utils/retry';
import { parseFirstJsonObject, validateChunkMentionsResult, normalizeChunkMentionsResult } from '../utils/validation';
import type { ChunkMentionsResult, ExtractChunkParams } from './types';

const SYSTEM_RULES = `You are a deterministic information extraction engine.
You MUST only extract explicit facts from the provided text.
You MUST NOT infer identity, aliases, or merge characters.
You MUST NOT summarize the story.
You MUST output strict JSON ONLY (no markdown, no prose).`;

function buildUserPrompt(chunkIndex: number, chunkText: string): string {
	return [
		`Task: Extract character mentions from the text chunk below.`,
		`Return ONLY this JSON object schema:`,
		`{`,
		`  "chunkIndex": number,`,
		`  "characters": [`,
		`    {`,
		`      "name": string,`,
		`      "descriptions": string[],`,
		`      "actions": string[]`,
		`    }`,
		`  ]`,
		`}`,
		`Rules:`,
		`- Use ONLY character names explicitly present in the text (proper nouns / named entities).`,
		`- If the text only uses pronouns (he/she/they) without a name, do NOT invent a name.`,
		`- descriptions: short phrases explicitly stated about that named character (appearance, role, traits).`,
		`- actions: short phrases explicitly stated as actions performed by that named character.`,
		`- Be conservative: omit uncertain items rather than guessing.`,
		`- Keep strings short; do not quote long passages.`,
		`- Ensure chunkIndex is exactly ${chunkIndex}.`,
		`Text chunk:`,
		chunkText
	].join('\n');
}

/**
 * Stateless, pure extraction: given (chunkIndex, chunkText) it returns observations only.
 * No shared state, no aggregation, no alias resolution.
 */
export async function extractCharacterMentionsFromChunk(params: ExtractChunkParams): Promise<ChunkMentionsResult> {
	return retryWithBackoff(async () => {
		const raw = await callCopilotChat(params.model, {
			system: SYSTEM_RULES,
			user: buildUserPrompt(params.chunkIndex, params.chunkText)
		}, params.token);

		const parsed = parseFirstJsonObject(raw);
		if (!validateChunkMentionsResult(parsed)) {
			throw new Error('Model output failed schema validation');
		}

		if (parsed.chunkIndex !== params.chunkIndex) {
			throw new Error(`Model returned chunkIndex=${parsed.chunkIndex} (expected ${params.chunkIndex})`);
		}

		return normalizeChunkMentionsResult(parsed);
	}, { retries: 2, baseDelayMs: 600 });
}

async function callCopilotChat(
	model: vscode.LanguageModelChat,
	prompt: { system: string; user: string },
	token?: vscode.CancellationToken
): Promise<string> {

	// The LM API supports only User/Assistant roles; bake system constraints into the user message.
	const content = `${prompt.system}\n\n${prompt.user}`;
	const messages = [vscode.LanguageModelChatMessage.User(content)];

	const response = await model.sendRequest(messages, {}, token);
	let out = '';
	for await (const chunk of response.text) {
		out += chunk;
	}
	return out;
}
