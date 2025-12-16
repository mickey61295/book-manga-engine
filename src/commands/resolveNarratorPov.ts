import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureDir, writeJsonStable } from '../utils/fs';
import { resolveNarratorPov } from '../pipeline/povResolver';

export async function resolveNarratorPovCommand(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		await vscode.window.showErrorMessage('Open a folder workspace before running narrator/POV resolution.');
		return;
	}

	const output = vscode.window.createOutputChannel('Story to Manga');
	output.show(true);
	output.appendLine(`[${new Date().toISOString()}] resolveNarratorPov: started`);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	status.text = 'Story→Manga: Resolving narrator/POV…';
	status.show();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Story→Manga: Narrator / POV resolution',
				cancellable: false
			},
			async (progress) => {
				const outDir = path.join(workspaceFolder.uri.fsPath, '.story-to-manga');
				const canonicalPath = path.join(outDir, 'characters_canonical.json');

				// Accept either name for the normalized scene timeline.
				const scenesCanonicalPath = path.join(outDir, 'scenes_canonical.json');
				const scenesNormalizedPath = path.join(outDir, 'scenes_normalized.json');
				const outPath = path.join(outDir, 'scenes_pov_resolved.json');

				progress.report({ message: 'Loading inputs…', increment: 0 });

				const canonicalBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(canonicalPath));
				const scenesBytes = await tryReadFirstExisting([scenesCanonicalPath, scenesNormalizedPath]);
				if (!scenesBytes) {
					throw new Error('Missing scenes_canonical.json or scenes_normalized.json (run Scene normalization first)');
				}

				const canonicalParsed: unknown = JSON.parse(Buffer.from(canonicalBytes).toString('utf8'));
				const scenesParsed: unknown = JSON.parse(Buffer.from(scenesBytes).toString('utf8'));

				if (!canonicalParsed || typeof canonicalParsed !== 'object') {
					throw new Error('Invalid characters_canonical.json (expected object)');
				}
				if (!scenesParsed || typeof scenesParsed !== 'object') {
					throw new Error('Invalid scenes_canonical/scenes_normalized (expected object)');
				}

				progress.report({ message: 'Resolving first-person POV…', increment: 70 });
				const result = resolveNarratorPov(scenesParsed as any, canonicalParsed as any);

				progress.report({ message: 'Writing output…', increment: 30 });
				await ensureDir(outDir);
				await writeJsonStable(outPath, result);

				status.text = `Story→Manga: Wrote ${path.relative(workspaceFolder.uri.fsPath, outPath)}`;
				output.appendLine(`[${new Date().toISOString()}] done: wrote ${outPath}`);
				await vscode.window.showInformationMessage(`Wrote ${outPath}`);
			}
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Narrator/POV resolution failed: ${msg}`);
		output.appendLine(`[${new Date().toISOString()}] error: ${msg}`);
	} finally {
		setTimeout(() => status.dispose(), 4000);
	}
}

async function tryReadFirstExisting(paths: string[]): Promise<Uint8Array | null> {
	for (const p of paths) {
		try {
			return await vscode.workspace.fs.readFile(vscode.Uri.file(p));
		} catch {
			// try next
		}
	}
	return null;
}
