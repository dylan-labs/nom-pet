// Ad-hoc smoke test: drive the journal pipeline without the full Electron
// app. Run with: node --experimental-strip-types scripts/test-journal.mts
//
// Reads the real ~/.nom/state.json (so it sees yesterday's data exactly
// like a normal launch would) and writes ~/.nom/journal/YYYY-MM-DD.md.
// LLM is honored if `settings.llm.enabled` is true in state; otherwise
// the template fallback runs. Safe to re-run — passes through the
// "file already exists" guard.

import { Store } from '../src/main/data/store.ts';
import { generateJournalForYesterday, regenerateJournal } from '../src/main/data/journal.ts';

const force = process.argv.includes('--force');

const store = new Store();
await store.load();
const settings = store.getSettings();
const snap = store.snapshot();

console.log('— state loaded —');
console.log('  petName    :', settings.petName);
console.log('  soulKernel :', settings.soulKernel?.preset ?? '(none)');
console.log('  llm enabled:', !!settings.llm?.enabled);
console.log('  cumulative :', snap.cumulative);
console.log('  today      :', snap.today);

const report = store.computeDailyReport();
console.log('— daily report —');
console.log('  yesterday  :', report?.yesterdayKey, '→', report?.yesterdayTokens, 'tokens');
console.log('  dayBefore  :', report?.dayBeforeTokens, 'tokens');
console.log('  weekAvg    :', report?.weekAvgTokens, 'tokens');

if (!report) {
  console.log('no yesterday data — nothing to write');
  process.exit(0);
}

console.log(`— generating ${force ? '(forced)' : ''} —`);
const entry = force
  ? await regenerateJournal(store, report.yesterdayKey)
  : await generateJournalForYesterday(store);

if (!entry) {
  console.log('no entry produced (likely: file already exists; pass --force to overwrite)');
  process.exit(0);
}

console.log('— entry written —');
console.log('  date        :', entry.date, entry.weekday);
console.log('  weather     :', entry.weather);
console.log('  generatedBy :', entry.generatedBy);
console.log('  bodyChars   :', entry.body.length);
console.log('  milestones  :', entry.metadata.milestonesCrossed);
console.log('');
console.log(entry.body);
