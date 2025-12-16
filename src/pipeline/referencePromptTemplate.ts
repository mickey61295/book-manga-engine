import type { NormalizedVisualTraits } from './visualTraitNormalizer';

const CLOSING_LINE = 'This is a character reference image for visual consistency.';

// Hard-coded base template. The LLM never sees this.
export function buildCharacterReferencePrompt(params: {
	character_id: string;
	traits: NormalizedVisualTraits;
}): string {
	const id = String(params.character_id ?? '').trim();
	const lines = Array.isArray(params.traits?.physical_description) ? params.traits.physical_description : [];

	const body = lines.map((l) => String(l ?? '').trim()).filter(Boolean).join('\n');
	const base = [
		`Character reference (neutral physical traits only)`,
		`character_id: ${id}`,
		`physical_traits:`,
		body
	]
		.filter((x) => String(x ?? '').trim().length > 0)
		.join('\n');

	return `${base}\n\n${CLOSING_LINE}`;
}
