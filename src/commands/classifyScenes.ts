import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureDir, writeJsonStable } from '../utils/fs';
import { classifyScenesForVisualGating } from '../pipeline/sceneClassifier';

export async function classifyScenesCommand(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		await vscode.window.showErrorMessage('Open a folder workspace before running scene classification.');
		return;
	}

	const output = vscode.window.createOutputChannel('Story to Manga');
	output.show(true);
	output.appendLine(`[${new Date().toISOString()}] classifyScenes: started`);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	status.text = 'Story→Manga: Classifying scenes…';
	status.show();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Story→Manga: Scene classification & visual gating',
				cancellable: false
			},
			async (progress) => {
				progress.report({ message: 'Loading inputs…', increment: 0 });
				const outDir = path.join(workspaceFolder.uri.fsPath, '.story-to-manga');
				const inPath = path.join(outDir, 'scenes_pov_resolved.json');
				const outPath = path.join(outDir, 'scenes_classified.json');

				const inBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(inPath));
				const parsed: unknown = JSON.parse(Buffer.from(inBytes).toString('utf8'));
				if (!parsed || typeof parsed !== 'object') {
					throw new Error('Invalid scenes_pov_resolved.json (expected object)');
				}

				progress.report({ message: 'Classifying…', increment: 80 });
				const result = classifyScenesForVisualGating(parsed as any);

				progress.report({ message: 'Writing output…', increment: 20 });
				await ensureDir(outDir);
				await writeJsonStable(outPath, result);

				status.text = `Story→Manga: Wrote ${path.relative(workspaceFolder.uri.fsPath, outPath)}`;
				output.appendLine(`[${new Date().toISOString()}] done: wrote ${outPath}`);
				await vscode.window.showInformationMessage(`Wrote ${outPath}`);
			}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Scene classification failed: ${msg}`);
		output.appendLine(`[${new Date().toISOString()}] error: ${msg}`);
	} finally {
		setTimeout(() => status.dispose(), 4000);
	}
}
