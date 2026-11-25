// The Codex form's stubs module (../../codex/src/stubs.ts) as the Muse bundle sees it: everything
// the same, but the stubs are written flat into Muse's own skill folder (muse.ts syncFlatStubs),
// because Muse lists a SKILL.md one folder down, never deeper. build.mjs gives this module to the
// Codex form's app.ts in place of its own, in the Muse bundle only; the Codex bundle and sources
// are as they are.
export * from '../../codex/src/stubs.ts';
export { syncFlatStubs as syncStubs } from './muse.ts';
