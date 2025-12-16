import * as path from 'node:path';
import * as vscode from 'vscode';
import { chunkText } from '../pipeline/chunker';
import { extractCharacterMentionsFromChunk } from '../pipeline/extractor';
import { mapWithConcurrency } from '../utils/pool';
import { ensureDir, writeJsonStable } from '../utils/fs';

const DEFAULT_CHUNK_SIZE = 3000;
const DEFAULT_OVERLAP_RATIO = 0.15;
const MAX_CONCURRENCY = 5;

export async function extractCharactersCommand(): Promise<void> {
	const output = vscode.window.createOutputChannel('Story to Manga');
	output.show(true);
	output.appendLine(`[${new Date().toISOString()}] extractCharacters: started`);

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		await vscode.window.showErrorMessage('No active editor. Open a .txt file first.');
		return;
	}

	const doc = editor.document;
	if (doc.isUntitled) {
		await vscode.window.showErrorMessage('Please save the file to disk before running extraction.');
		return;
	}

	if (doc.languageId !== 'plaintext' && !doc.fileName.toLowerCase().endsWith('.txt')) {
		await vscode.window.showErrorMessage('Only .txt/plaintext files are supported right now.');
		return;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri) ?? vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		await vscode.window.showErrorMessage('Open a folder workspace before running extraction.');
		return;
	}

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	status.text = 'Story→Manga: Preparing…';
	status.show();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Story→Manga: Extracting character mentions',
				cancellable: true
			},
			async (progress, token) => {
		const fullText = doc.getText();
		const overlapChars = Math.max(1, Math.floor(DEFAULT_CHUNK_SIZE * DEFAULT_OVERLAP_RATIO));
		const chunks = chunkText(fullText, {
			chunkSize: DEFAULT_CHUNK_SIZE,
			overlap: overlapChars
		});
		output.appendLine(`[${new Date().toISOString()}] chunking: ${chunks.length} chunks (size=${DEFAULT_CHUNK_SIZE}, overlap=${overlapChars})`);

		status.text = `Story→Manga: Selecting Copilot model…`;
		const model = await selectCopilotChatModel();
		if (!model) {
			await vscode.window.showErrorMessage('No Copilot chat model available (vscode.lm).');
			return;
		}
		output.appendLine(`[${new Date().toISOString()}] model: ${model.vendor}/${model.family} id=${model.id}`);

		const total = chunks.length;
		let done = 0;
		status.text = `Story→Manga: Extracting 0/${total}…`;
		progress.report({ message: `0/${total}`, increment: 0 });

		const results = await mapWithConcurrency(
			chunks,
			MAX_CONCURRENCY,
			async (chunk, index) => {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}
				if (index === 0 || index % 10 === 0) {
					output.appendLine(`[${new Date().toISOString()}] processing: chunk ${index}/${total}`);
				}
				const res = await extractCharacterMentionsFromChunk({
					chunkIndex: index,
					chunkText: chunk,
					model,
					token
				});
				done += 1;
				status.text = `Story→Manga: Extracting ${done}/${total}…`;
				progress.report({ message: `${done}/${total}`, increment: (1 / total) * 100 });
				return res;
			}
		);

		if (token.isCancellationRequested) {
			throw new Error('Cancelled');
		}

		const outDir = path.join(workspaceFolder.uri.fsPath, '.story-to-manga');
		await ensureDir(outDir);

		const outPath = path.join(outDir, 'mentions_raw.json');
		const artifact = {
			sourceFile: doc.uri.fsPath,
			chunkSize: DEFAULT_CHUNK_SIZE,
			overlap: overlapChars,
			mentions: results
		};

		await writeJsonStable(outPath, artifact);
		status.text = `Story→Manga: Wrote ${path.relative(workspaceFolder.uri.fsPath, outPath)}`;
		await vscode.window.showInformationMessage(`Wrote ${outPath}`);
		output.appendLine(`[${new Date().toISOString()}] done: wrote ${outPath}`);
		}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Extraction failed: ${msg}`);
		output.appendLine(`[${new Date().toISOString()}] error: ${msg}`);
	} finally {
		setTimeout(() => status.dispose(), 4000);
	}
}


async function selectCopilotChatModel(): Promise<vscode.LanguageModelChat | undefined> {
	const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	if (!models.length) return undefined;

	// Prefer a specific model id if present, otherwise fall back to first.
	return models.find((m) => m.id === 'gpt-5-mini') ?? models[0];
}
