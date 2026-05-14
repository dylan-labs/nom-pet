// Ad-hoc smoke: drive one tick + onActivity to verify the autonomy
// pipeline end-to-end. Subscribes to bubble/decision events so you can
// see what the LLM decided. Run with: npm run tick:test
//
// Side effects: writes ~/.nom/pet-mind/* using your real Store state.
// Toggles autonomy on for the duration, then restores it to off.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Store } from '../src/main/data/store.ts';
import { TickEngine } from '../src/main/data/tick.ts';

const store = new Store();
await store.load();
store.setAutonomy({ enabled: true });

console.log('— state loaded —');
console.log('  petName    :', store.getSettings().petName);
console.log('  llm enabled:', !!store.getSettings().llm?.enabled);
console.log('  autonomy   :', store.getSettings().autonomy);

const tick = new TickEngine(store);

// Listen to autonomy emissions so we can see what the LLM decided.
tick.on('bubble', (b) => {
  console.log(`\n💬 BUBBLE (${b.kind}, mood=${b.mood}, ${b.durationMs}ms):`);
  console.log(`   ${b.text}`);
});
tick.on('decision', (d) => {
  console.log(`\n🧠 DECISION action=${d.action}${d.reason ? ` · reason=${d.reason}` : ''}`);
});

console.log('\n— simulating a 4-hour absence + return —');
await tick.onActivity(Date.now() - 4 * 3600 * 1000);
await tick.onActivity(Date.now());

console.log('\n— forcing one tick (bypasses 60 s warm-up) —');
await (tick as unknown as { tick: (r: string) => Promise<void> }).tick('smoke');

console.log('\n— pet-mind contents (tail) —');
const dir = path.join(os.homedir(), '.nom', 'pet-mind');
for (const f of ['notes.jsonl', 'mood.json', 'absences.json', 'last-tick.json', 'bubble-count.json']) {
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

// Reset autonomy so the test doesn't surprise the user later.
store.setAutonomy({ enabled: false });
await store.flush();
console.log('\n— autonomy reset to disabled (test cleanup) —');
