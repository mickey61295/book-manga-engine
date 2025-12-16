import * as path from 'node:path';
import * as vscode from 'vscode';
import { detectAppearanceStates } from '../pipeline/appearanceDetector';
import { ensureDir, writeJsonStable } from '../utils/fs';

async function readJsonIfExists(filePath: string): Promise<unknown> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
		return JSON.parse(Buffer.from(bytes).toString('utf8'));
	} catch {
		return undefined;
	}
}

export async function detectAppearanceStatesCommand(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		await vscode.window.showErrorMessage('Open a folder workspace before running appearance state detection.');
		return;
	}

	const output = vscode.window.createOutputChannel('Story to Manga');
	output.show(true);
	output.appendLine(`[${new Date().toISOString()}] detectAppearanceStates: started`);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	status.text = 'Story→Manga: Detecting appearance states…';
	status.show();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Story→Manga: Appearance state detection',
				cancellable: false
			},
			async (progress) => {
				progress.report({ message: 'Loading inputs…', increment: 0 });
				const outDir = path.join(workspaceFolder.uri.fsPath, '.story-to-manga');

				const scenesPovPath = path.join(outDir, 'scenes_pov_resolved.json');
				const scenesClassifiedPath = path.join(outDir, 'scenes_classified.json');
				const canonicalPath = path.join(outDir, 'characters_canonical.json');
				const existingStatesPath = path.join(outDir, 'appearance_states.json');

				const scenesPov = await readJsonIfExists(scenesPovPath);
				const scenesClassified = await readJsonIfExists(scenesClassifiedPath);
				const canonicalCharacters = await readJsonIfExists(canonicalPath);
				const existingStates = await readJsonIfExists(existingStatesPath);

				if (!scenesPov || typeof scenesPov !== 'object') {
					throw new Error('Missing or invalid scenes_pov_resolved.json');
				}
				if (!scenesClassified || typeof scenesClassified !== 'object') {
					throw new Error('Missing or invalid scenes_classified.json');
				}
				if (!canonicalCharacters || typeof canonicalCharacters !== 'object') {
					throw new Error('Missing or invalid characters_canonical.json');
				}

				progress.report({ message: 'Detecting states…', increment: 85 });
				const result = detectAppearanceStates({
					scenesPovResolved: scenesPov as any,
					scenesClassified: scenesClassified as any,
					canonicalCharacters: canonicalCharacters as any,
					existingStates: existingStates as any
				});

				progress.report({ message: 'Writing outputs…', increment: 15 });
				await ensureDir(outDir);

				const drawableOutPath = path.join(outDir, 'scenes_drawable.json');
				const statesOutPath = path.join(outDir, 'appearance_states.json');
				const eventsOutPath = path.join(outDir, 'appearance_events.json');

				await writeJsonStable(drawableOutPath, result.scenes_drawable);
				await writeJsonStable(statesOutPath, result.appearance_states);
				await writeJsonStable(eventsOutPath, result.appearance_events);

				status.text = `Story→Manga: Wrote ${path.relative(workspaceFolder.uri.fsPath, eventsOutPath)}`;
				output.appendLine(`[${new Date().toISOString()}] done: wrote ${eventsOutPath}`);
				await vscode.window.showInformationMessage(`Wrote ${eventsOutPath}`);
			}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Appearance detection failed: ${msg}`);
		output.appendLine(`[${new Date().toISOString()}] error: ${msg}`);
	} finally {
		setTimeout(() => status.dispose(), 4000);
	}
}
