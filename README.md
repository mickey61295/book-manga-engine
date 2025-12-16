# Story to Manga Engine (VS Code Extension)

Deterministic narrative processing stage 1: extract **factual character mentions** from large story `.txt` files using the VS Code Language Model (Copilot) API.

This is **not** an image generator. It produces inspectable JSON artifacts that later stages (aggregation/canonicalization/scene planning) can consume.

## What it does

- Splits a large story into small overlapping chunks (default: ~3000 chars, ~15% overlap)
- Runs a **stateless** extraction per chunk via the Copilot LM API
- Uses **controlled parallelism** (max concurrency 5) without mutating shared state
- Writes a stable, human-readable artifact:
  - `.story-to-manga/mentions_raw.json`
  - `.story-to-manga/characters_aggregated.json` (deterministic, no LLM)
  - `.story-to-manga/characters_canonical.json` (Copilot, per character)
  - `.story-to-manga/scenes_raw.json` (Copilot, per chunk)

## Key invariants

- **Stateless extraction**: each chunk returns observations only (no alias resolution, no canonical profiles)
- **Deterministic output shape**: chunk indices preserved, stable sorting inside each chunk
- **Order-independence**: concurrency `1` vs `5` yields the same `mentions_raw.json` ordering

## Requirements

- VS Code with GitHub Copilot enabled
- Extension uses the proposed API `languageModelSystem` (see `enabledApiProposals` in `package.json`)

## How to run (development)

1. Install dependencies:

   ```bash
   npm install
   ```

2. Compile:

   ```bash
   npm run compile
   ```

3. Press `F5` to launch the Extension Development Host.

4. In the Dev Host window:
   - Open a `.txt` file in the editor
   - Run the command:
     - **Story to Manga: Extract Characters (Mentions)**

## Output

The command writes:

- `.story-to-manga/mentions_raw.json`

It includes:

- `sourceFile`
- `chunkSize`
- `overlap`
- `mentions`: array of per-chunk results

Each chunk result follows:

```json
{
  "chunkIndex": 4,
  "characters": [
    {
      "name": "Akira",
      "descriptions": ["scar on eyebrow"],
      "actions": ["leans against wall"]
    }
  ]
}
```

## Seeing processing status

- A **status bar** indicator shows high-level progress.
- A **notification progress** UI shows `done/total` and supports Cancel.
- The **Output** channel named **"Story to Manga"** logs milestones and periodic chunk progress.

## Scene extraction

Run:

- **Story to Manga: Extract Scenes (Copilot)**

It writes `.story-to-manga/scenes_raw.json` containing per-chunk **raw** scene fragments (character refs may include pronouns like "I").

## GPT-5-mini character visual trait normalization

Run:

- **Story to Manga: Normalize Character Visual Traits (GPT-5-mini)**

This stage uses GPT-5-mini via `vscode.lm` as a constrained **normalization pass**. It rewrites existing character description evidence into neutral physical trait lines and never generates full prompts.

Outputs:

- `.story-to-manga/character_visual_traits.json`
- `.story-to-manga/character_reference_prompts.json`

## Scene normalization

Prereqs:

- Run **Extract Characters (Mentions)**
- Run `npm run aggregate`
- Run **Canonicalize Characters (Copilot)**
- Run **Extract Scenes (Copilot)**

Then run:

- **Story to Manga: Normalize & Merge Scenes**

It resolves aliases/pronouns to canonical drawable character IDs, filters non-drawable entities, merges overlaps across chunks, and writes `.story-to-manga/scenes_normalized.json`.

## Narrator / POV resolution

Run:

- **Story to Manga: Resolve Narrator / POV**

This stage only resolves **first-person** tokens (I/me/my/we/our/us) when it is safe and deterministic, otherwise it drops those references. It never resolves third-person pronouns. Output: `.story-to-manga/scenes_pov_resolved.json`.

## Scene classification (visual gate)

Run:

- **Story to Manga: Classify Scenes (Visual Gate)**

This stage classifies each scene into a narrative `kind` and sets `drawable` conservatively (only `visual_scene` and `dialogue_scene` become drawable). It never changes scene content or ordering. Output: `.story-to-manga/scenes_classified.json`.

## Appearance states (visual consistency core)

Run:

- **Story to Manga: Detect Appearance States**

This stage operates deterministically on **drawable** scenes only and tracks mutable visual traits (e.g. clothing/hair/condition) **only when explicitly evidenced** in the scene actions. If no explicit evidence is present, it reuses the previous known state.

Outputs:

- `.story-to-manga/scenes_drawable.json`
- `.story-to-manga/appearance_states.json`
- `.story-to-manga/appearance_events.json`

## Panel segmentation

Run:

- **Story to Manga: Segment Panels**

This stage deterministically breaks each drawable scene into ordered manga panels (one primary action per panel), without inventing new actions/dialogue/details.

Output:

- `.story-to-manga/panels.json`

## Troubleshooting

- **"No Copilot chat model available"**: ensure Copilot is installed/enabled and you’re running the command in response to a user action.
- **Cancelled**: you can cancel from the notification progress UI.

## What’s intentionally not implemented yet

- Panel/page layout planning
- Image generation
- PDF ingestion
