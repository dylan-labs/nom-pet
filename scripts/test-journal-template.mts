// Template-path smoke test: force the LLM-off path by handing
// renderTemplateJournal real yesterday metadata pulled from the store,
// and print every mood bucket once to sanity-check the prose.

import { Store } from '../src/main/data/store.ts';
import { renderTemplateJournal } from '../src/main/data/journal-template.ts';
import type { JournalDailyMetadata } from '../src/shared/types.ts';

const store = new Store();
await store.load();
const settings = store.getSettings();
const report = store.computeDailyReport();
if (!report) { console.log('no yesterday data'); process.exit(0); }

const meta: JournalDailyMetadata = {
  dateKey: report.yesterdayKey,
  weekday: 'Wed',
  yesterdayTokens: report.yesterdayTokens,
  dayBeforeTokens: report.dayBeforeTokens,
  weekAvgTokens: report.weekAvgTokens,
  milestonesCrossed: [],
};

console.log('— real yesterday metadata —');
console.log(meta);

console.log('\n— template render against real data —');
for (let i = 0; i < 3; i++) {
  const r = renderTemplateJournal(meta, settings.petName);
  console.log(`  [${i}] weather=${r.weather}`);
  console.log(`      ${r.body}`);
}

console.log('\n— template render against synthetic "饿了一整天" metadata —');
const empty: JournalDailyMetadata = { ...meta, yesterdayTokens: 0 };
for (let i = 0; i < 3; i++) {
  const r = renderTemplateJournal(empty, settings.petName);
  console.log(`  [${i}] weather=${r.weather}`);
  console.log(`      ${r.body}`);
}
