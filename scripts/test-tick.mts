// Ad-hoc smoke: drive a single tick + onActivity to verify pet-mind/
// files land correctly. Phase 1 only — no LLM involved.
//
// Run with: npm run tick:test
//
// Side effects: writes ~/.nom/pet-mind/ {notes.jsonl, mood.json,
// absences.json, last-tick.json}. Reuses real Store state, so for a
// clean test delete ~/.nom/pet-mind/ before running.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Store } from '../src/main/data/store.ts';
import { TickEngine } from '../src/main/data/tick.ts';

const store = new Store();
await store.load();

// Enable autonomy for the duration of the test.
store.setAutonomy({ enabled: true });

console.log('— state loaded —');
console.log('  petName:', store.getSettings().petName);
console.log('  autonomy:', store.getSettings().autonomy);

const tick = new TickEngine(store);

console.log('\n— simulating an activity event 4 hours ago, then now —');
// Simulate that the user was last active 4 hours ago, so the next
// onActivity logs a gap.
await tick.onActivity(Date.now() - 4 * 3600 * 1000);
await tick.onActivity(Date.now());

console.log('\n— forcing a tick (bypasses the 60s warm-up) —');
// We call the private tick by reaching through the start machinery —
// just call the underlying methods directly to keep the test honest.
// (Using a tiny hack: temporarily call start() then immediately fire.
// Simpler: invoke via a public testing helper we don't have. So we
// reach through via type cast for the smoke test only.)
await (tick as unknown as { tick: (r: string) => Promise<void> }).tick('smoke');

console.log('\n— pet-mind contents —');
const dir = path.join(os.homedir(), '.nom', 'pet-mind');
for (const f of ['notes.jsonl', 'mood.json', 'absences.json', 'last-tick.json']) {
  const p = path.join(dir, f);
  try {
    const text = await fs.readFile(p, 'utf8');
    console.log(`\n  ${f}:`);
    for (const line of text.trim().split('\n').slice(-5)) {
      console.log(`    ${line}`);
    }
  } catch {
    console.log(`  ${f}: <missing>`);
  }
}

// Restore the user's previous setting so we don't surprise them.
store.setAutonomy({ enabled: false });
await store.flush();
console.log('\n— autonomy reset to disabled (test cleanup) —');
