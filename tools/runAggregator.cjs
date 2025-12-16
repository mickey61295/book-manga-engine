const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const root = process.cwd();
  const inPath = path.join(root, '.story-to-manga', 'mentions_raw.json');
  const outPath = path.join(root, '.story-to-manga', 'characters_aggregated.json');

  // Use compiled (CommonJS) outputs.
  const { aggregateCharacters } = require(path.join(root, 'dist', 'pipeline', 'aggregator.js'));
  const { writeJsonStable } = require(path.join(root, 'dist', 'utils', 'fs.js'));

  const raw = await fs.readFile(inPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.mentions)) {
    throw new Error(`Invalid input: expected { mentions: ChunkResult[] } in ${inPath}`);
  }

  const result = aggregateCharacters(parsed.mentions);
  await writeJsonStable(outPath, result);

  process.stdout.write(`Wrote ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
