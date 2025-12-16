import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureDir, writeJsonStable } from '../utils/fs';
import type { AggregationResult } from '../pipeline/aggregator';
import { normalizeCharacterVisualTraits } from '../pipeline/visualTraitNormalizer';
import { buildCharacterReferencePrompt } from '../pipeline/referencePromptTemplate';

type CanonicalCharactersArtifact = {
	characters: Record<
		string,
		{
			character_id: string;
			drawable: boolean;
			aliases?: string[];
		}
	>;
};

async function readJson(filePath: string): Promise<unknown> {
	const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
	return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

export async function normalizeCharacterVisualTraitsCommand(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		await vscode.window.showErrorMessage('Open a folder workspace before running visual trait normalization.');
		return;
	}

	const output = vscode.window.createOutputChannel('Story to Manga');
	output.show(true);
	output.appendLine(`[${new Date().toISOString()}] normalizeCharacterVisualTraits: started`);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	status.text = 'Story→Manga: Normalizing character traits…';
	status.show();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Story→Manga: GPT-5-mini visual trait normalization',
				cancellable: true
			},
			async (progress, token) => {
				const outDir = path.join(workspaceFolder.uri.fsPath, '.story-to-manga');
				const canonicalPath = path.join(outDir, 'characters_canonical.json');
				const aggregatedPath = path.join(outDir, 'characters_aggregated.json');

				progress.report({ message: 'Loading inputs…', increment: 0 });
				const canonicalRaw = await readJson(canonicalPath);
				const aggregatedRaw = await readJson(aggregatedPath);

				if (!canonicalRaw || typeof canonicalRaw !== 'object') {
					throw new Error('Invalid characters_canonical.json (expected object)');
				}
				if (!aggregatedRaw || typeof aggregatedRaw !== 'object') {
					throw new Error('Invalid characters_aggregated.json (expected object)');
				}

				const canonical = canonicalRaw as CanonicalCharactersArtifact;
				const aggregated = aggregatedRaw as AggregationResult;
				if (!canonical.characters || typeof canonical.characters !== 'object') {
					throw new Error('Invalid characters_canonical.json: expected { characters: Record<string, ...> }');
				}
				if (!aggregated.characters || typeof aggregated.characters !== 'object') {
					throw new Error('Invalid characters_aggregated.json: expected { characters: Record<string, ...> }');
				}

				status.text = 'Story→Manga: Selecting GPT-5-mini…';
				const model = await selectCopilotChatModelPreferGpt5Mini();
				if (!model) {
					await vscode.window.showErrorMessage('No Copilot chat model available (vscode.lm).');
					return;
				}
				output.appendLine(`[${new Date().toISOString()}] model: ${model.vendor}/${model.family} id=${model.id}`);

				const entries = Object.entries(canonical.characters).sort((a, b) => a[0].localeCompare(b[0], 'en'));
				const drawable = entries.filter(([, c]) => c?.drawable === true);

				const total = drawable.length;
				let done = 0;
				progress.report({ message: `0/${total}`, increment: 0 });

				const traitsOut: Record<string, { character_id: string; physical_description: string[]; source_descriptions: string[] }> = {};
				const promptsOut: Record<string, { character_id: string; prompt: string }> = {};

				for (const [canonicalName, c] of drawable) {
					if (token.isCancellationRequested) throw new Error('Cancelled');
					const character_id = String(c.character_id ?? '').trim();
					if (!character_id) continue;

					const sourceDescriptions = getTopCanonicalDescriptions(aggregated, canonicalName, 20);

					status.text = `Story→Manga: Normalizing ${done + 1}/${total}…`;
					const traits = await normalizeCharacterVisualTraits(
						{
							character_id,
							canonical_descriptions: sourceDescriptions,
							rules: {
								allowed: [
									'body build',
									'proportions',
									'skin texture',
									'facial structure',
									'hair presence'
								],
								forbidden: [
									'emotion',
									'style',
									'lighting',
									'camera',
									'genre',
									'art terms'
								]
							}
						},
						model,
						token
					);

					traitsOut[character_id] = {
						character_id,
						physical_description: traits.physical_description,
						source_descriptions: sourceDescriptions
					};

					const prompt = buildCharacterReferencePrompt({ character_id, traits });
					promptsOut[character_id] = { character_id, prompt };

					done += 1;
					progress.report({ message: `${done}/${total}`, increment: (1 / Math.max(1, total)) * 100 });
					if (done === 1 || done % 5 === 0 || done === total) {
						output.appendLine(`[${new Date().toISOString()}] normalized: ${done}/${total}`);
					}
				}

				await ensureDir(outDir);
				const traitsPath = path.join(outDir, 'character_visual_traits.json');
				const promptsPath = path.join(outDir, 'character_reference_prompts.json');

				await writeJsonStable(traitsPath, { traits: traitsOut });
				await writeJsonStable(promptsPath, { prompts: promptsOut });

				status.text = `Story→Manga: Wrote ${path.relative(workspaceFolder.uri.fsPath, traitsPath)}`;
				output.appendLine(`[${new Date().toISOString()}] done: wrote ${traitsPath}`);
				await vscode.window.showInformationMessage(`Wrote ${traitsPath}`);
			}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Trait normalization failed: ${msg}`);
		output.appendLine(`[${new Date().toISOString()}] error: ${msg}`);
	} finally {
		setTimeout(() => status.dispose(), 4000);
	}
}

function getTopCanonicalDescriptions(aggregated: AggregationResult, canonicalName: string, max: number): string[] {
	const record = (aggregated.characters as any)?.[canonicalName];
	const desc = record?.descriptions && typeof record.descriptions === 'object' ? (record.descriptions as Record<string, number>) : {};
	const entries = Object.entries(desc)
		.filter(([k, v]) => typeof k === 'string' && k.trim().length > 0 && typeof v === 'number' && v > 0)
		.sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1];
			return a[0].localeCompare(b[0], 'en');
		});

	return entries.slice(0, Math.max(0, max)).map(([k]) => k);
}

async function selectCopilotChatModelPreferGpt5Mini(): Promise<vscode.LanguageModelChat | undefined> {
	const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	if (!models.length) return undefined;
	return models.find((m) => m.id === 'gpt-5-mini') ?? models[0];
}
