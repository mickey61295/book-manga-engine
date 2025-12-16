import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureDir, writeJsonStable } from '../utils/fs';
import { segmentScenesToPanels } from '../pipeline/panelSegmenter';

async function readJsonIfExists(filePath: string): Promise<unknown> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
		return JSON.parse(Buffer.from(bytes).toString('utf8'));
	} catch {
		return undefined;
	}
}

export async function segmentPanelsCommand(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		await vscode.window.showErrorMessage('Open a folder workspace before running panel segmentation.');
		return;
	}

	const output = vscode.window.createOutputChannel('Story to Manga');
	output.show(true);
	output.appendLine(`[${new Date().toISOString()}] segmentPanels: started`);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	status.text = 'Story→Manga: Segmenting panels…';
	status.show();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Story→Manga: Panel segmentation',
				cancellable: false
			},
			async (progress) => {
				progress.report({ message: 'Loading inputs…', increment: 0 });
				const outDir = path.join(workspaceFolder.uri.fsPath, '.story-to-manga');

				const scenesDrawablePath = path.join(outDir, 'scenes_drawable.json');
				const appearanceEventsPath = path.join(outDir, 'appearance_events.json');

				const scenesDrawable = await readJsonIfExists(scenesDrawablePath);
				const appearanceEvents = await readJsonIfExists(appearanceEventsPath);

				if (!scenesDrawable || typeof scenesDrawable !== 'object') {
					throw new Error('Missing or invalid scenes_drawable.json');
				}

				progress.report({ message: 'Segmenting…', increment: 85 });
				const result = segmentScenesToPanels({
					scenesDrawable: scenesDrawable as any,
					appearanceEvents: appearanceEvents as any
				});

				progress.report({ message: 'Writing output…', increment: 15 });
				await ensureDir(outDir);

				const panelsOutPath = path.join(outDir, 'panels.json');
				await writeJsonStable(panelsOutPath, result);

				status.text = `Story→Manga: Wrote ${path.relative(workspaceFolder.uri.fsPath, panelsOutPath)}`;
				output.appendLine(`[${new Date().toISOString()}] done: wrote ${panelsOutPath}`);
				await vscode.window.showInformationMessage(`Wrote ${panelsOutPath}`);
			}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Panel segmentation failed: ${msg}`);
		output.appendLine(`[${new Date().toISOString()}] error: ${msg}`);
	} finally {
		setTimeout(() => status.dispose(), 4000);
	}
}
