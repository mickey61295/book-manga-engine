import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureDir, writeJsonStable } from '../utils/fs';
import { normalizeAndMergeScenes } from '../pipeline/sceneNormalizer';

export async function normalizeScenesCommand(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		await vscode.window.showErrorMessage('Open a folder workspace before running scene normalization.');
		return;
	}

	const output = vscode.window.createOutputChannel('Story to Manga');
	output.show(true);
	output.appendLine(`[${new Date().toISOString()}] normalizeScenes: started`);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	status.text = 'Story→Manga: Normalizing scenes…';
	status.show();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Story→Manga: Normalize & merge scenes',
				cancellable: false
			},
			async (progress) => {
				progress.report({ message: 'Loading inputs…', increment: 0 });

				const outDir = path.join(workspaceFolder.uri.fsPath, '.story-to-manga');
				const scenesRawPath = path.join(outDir, 'scenes_raw.json');
				const canonicalPath = path.join(outDir, 'characters_canonical.json');
				const outPath = path.join(outDir, 'scenes_normalized.json');

				const rawBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(scenesRawPath));
				const canonicalBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(canonicalPath));

				const rawParsed: unknown = JSON.parse(Buffer.from(rawBytes).toString('utf8'));
				const canonicalParsed: unknown = JSON.parse(Buffer.from(canonicalBytes).toString('utf8'));

				if (!rawParsed || typeof rawParsed !== 'object') {
					throw new Error('Invalid scenes_raw.json (expected object)');
				}
				if (!canonicalParsed || typeof canonicalParsed !== 'object') {
					throw new Error('Invalid characters_canonical.json (expected object)');
				}

				progress.report({ message: 'Normalizing…', increment: 60 });
				const result = normalizeAndMergeScenes(rawParsed as any, canonicalParsed as any);

				progress.report({ message: 'Writing output…', increment: 40 });
				await ensureDir(outDir);
				await writeJsonStable(outPath, result);

				status.text = `Story→Manga: Wrote ${path.relative(workspaceFolder.uri.fsPath, outPath)}`;
				output.appendLine(`[${new Date().toISOString()}] done: wrote ${outPath}`);
				await vscode.window.showInformationMessage(`Wrote ${outPath}`);
			}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Scene normalization failed: ${msg}`);
		output.appendLine(`[${new Date().toISOString()}] error: ${msg}`);
	} finally {
		setTimeout(() => status.dispose(), 4000);
	}
}
