import type * as vscode from 'vscode';

export interface CharacterMention {
	name: string;
	descriptions: string[];
	actions: string[];
}

export interface ChunkMentionsResult {
	chunkIndex: number;
	characters: CharacterMention[];
}

export interface ExtractChunkParams {
	chunkIndex: number;
	chunkText: string;
	model: vscode.LanguageModelChat;
	token?: vscode.CancellationToken;
}
