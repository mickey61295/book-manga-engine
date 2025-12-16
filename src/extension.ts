import * as vscode from 'vscode';
import { canonicalizeCharactersCommand } from './commands/canonicalizeCharacters';
import { detectAppearanceStatesCommand } from './commands/detectAppearanceStates';
import { extractCharactersCommand } from './commands/extractCharacters';
import { extractScenesCommand } from './commands/extractScenesCommand';
import { normalizeCharacterVisualTraitsCommand } from './commands/normalizeCharacterVisualTraits';
import { segmentPanelsCommand } from './commands/segmentPanels';
import { normalizeScenesCommand } from './commands/normalizeScenes';
import { resolveNarratorPovCommand } from './commands/resolveNarratorPov';
import { classifyScenesCommand } from './commands/classifyScenes';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('storyToManga.extractCharacters', extractCharactersCommand),
		vscode.commands.registerCommand('storyToManga.canonicalizeCharacters', canonicalizeCharactersCommand),
		vscode.commands.registerCommand('storyToManga.normalizeCharacterVisualTraits', normalizeCharacterVisualTraitsCommand),
		vscode.commands.registerCommand('storyToManga.extractScenes', extractScenesCommand),
		vscode.commands.registerCommand('storyToManga.normalizeScenes', normalizeScenesCommand),
		vscode.commands.registerCommand('storyToManga.resolveNarratorPov', resolveNarratorPovCommand),
		vscode.commands.registerCommand('storyToManga.classifyScenes', classifyScenesCommand),
		vscode.commands.registerCommand('storyToManga.detectAppearanceStates', detectAppearanceStatesCommand),
		vscode.commands.registerCommand('storyToManga.segmentPanels', segmentPanelsCommand)
	);
}

export function deactivate() {
	// no-op
}
