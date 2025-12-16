import * as path from 'node:path';
import * as vscode from 'vscode';
import { canonicalizeCharacter, stableCharacterIdFromName } from '../pipeline/canonicalizer';
import type { AggregatedCharacter, AggregationResult } from '../pipeline/aggregator';
import { ensureDir, writeJsonStable } from '../utils/fs';

export async function canonicalizeCharactersCommand(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		await vscode.window.showErrorMessage('Open a folder workspace before running canonicalization.');
		return;
	}

	const output = vscode.window.createOutputChannel('Story to Manga');
	output.show(true);
	output.appendLine(`[${new Date().toISOString()}] canonicalizeCharacters: started`);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	status.text = 'Story→Manga: Canonicalizing…';
	status.show();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Story→Manga: Canonical character synthesis',
				cancellable: true
			},
			async (progress, token) => {
				const inPath = path.join(workspaceFolder.uri.fsPath, '.story-to-manga', 'characters_aggregated.json');
				const outDir = path.join(workspaceFolder.uri.fsPath, '.story-to-manga');
				const outPath = path.join(outDir, 'characters_canonical.json');

				const inBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(inPath));
				const parsed = JSON.parse(Buffer.from(inBytes).toString('utf8')) as AggregationResult;
				if (!parsed || typeof parsed !== 'object' || !parsed.characters || typeof parsed.characters !== 'object') {
					throw new Error('Invalid characters_aggregated.json: expected { characters: Record<string, AggregatedCharacter> }');
				}

				status.text = 'Story→Manga: Selecting Copilot model…';
				const model = await selectCopilotChatModel();
				if (!model) {
					await vscode.window.showErrorMessage('No Copilot chat model available (vscode.lm).');
					return;
				}
				output.appendLine(`[${new Date().toISOString()}] model: ${model.vendor}/${model.family} id=${model.id}`);

				const entries = Object.entries(parsed.characters)
					.sort((a, b) => a[0].localeCompare(b[0], 'en'));

				const total = entries.length;
				let done = 0;
				progress.report({ message: `0/${total}`, increment: 0 });

				const outCharacters: Record<string, any> = {};

				for (const [canonicalName, agg] of entries) {
					if (token.isCancellationRequested) throw new Error('Cancelled');

					// Ensure stable id regardless of model behavior.
					const character_id = stableCharacterIdFromName(canonicalName);
					const input: AggregatedCharacter = {
						canonical_name: canonicalName,
						aliases: Array.isArray(agg.aliases) ? agg.aliases : [canonicalName],
						mentions: typeof agg.mentions === 'number' ? agg.mentions : 0,
						descriptions: agg.descriptions ?? {},
						actions: agg.actions ?? {},
						chunks: Array.isArray(agg.chunks) ? agg.chunks : []
					};

					status.text = `Story→Manga: Canonicalizing ${done + 1}/${total}…`;
					const result = await canonicalizeCharacter(
						{
							...input,
							canonical_name: canonicalName
						},
						model,
						token
					);

					// Extra guard: keep stable id in file key and payload.
					outCharacters[canonicalName] = { ...result, character_id, aliases: input.aliases };

					done += 1;
					progress.report({ message: `${done}/${total}`, increment: (1 / total) * 100 });
					if (done === 1 || done % 5 === 0 || done === total) {
						output.appendLine(`[${new Date().toISOString()}] canonicalized: ${done}/${total}`);
					}
				}

				await ensureDir(outDir);
				await writeJsonStable(outPath, { characters: outCharacters });
				status.text = `Story→Manga: Wrote ${path.relative(workspaceFolder.uri.fsPath, outPath)}`;
				output.appendLine(`[${new Date().toISOString()}] done: wrote ${outPath}`);
				await vscode.window.showInformationMessage(`Wrote ${outPath}`);
			}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Canonicalization failed: ${msg}`);
		output.appendLine(`[${new Date().toISOString()}] error: ${msg}`);
	} finally {
		setTimeout(() => status.dispose(), 4000);
	}
}

async function selectCopilotChatModel(): Promise<vscode.LanguageModelChat | undefined> {
	const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	if (!models.length) return undefined;
	return models.find((m) => m.id === 'gpt-5-mini') ?? models[0];
}
