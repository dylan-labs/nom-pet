import type { JournalDailyMetadata } from '../../shared/types';

/**
 * Pure-template fallback when the LLM is off or unreachable. Per the
 * Phase-2 ship criterion, the daily journal file must exist even with
 * zero network — so this path has to produce something readable, not
 * "[LLM unavailable]".
 *
 * Lines are mood-grouped; each mood has ≥6 templates to avoid obvious
 * repetition across days. Tokens are described qualitatively (small /
 * solid / overstuffed) so the templates read like prose, not invoices.
 */

type Mood = 'happy' | 'tired' | 'angry' | 'meh';

const WEATHER_BY_MOOD: Record<Mood, string[]> = {
  happy: ['☀', '🌤', '🌈'],
  tired: ['🌧', '☔', '🌫'],
  angry: ['🌪', '⛈'],
  meh:   ['☁', '🌫'],
};

/**
 * Bucket yesterday into one of four moods purely from the numbers we
 * have. The LLM path uses richer cues (peakHour, idle gap) but the
 * template path stays deterministic for offline reproducibility.
 */
function pickMood(m: JournalDailyMetadata): Mood {
  const y = m.yesterdayTokens;
  if (y === 0) return 'angry';
  // "Overfed" relative to the user's own week: > 2× average and over 50k absolute.
  if (m.weekAvgTokens > 0 && y > m.weekAvgTokens * 2 && y > 50_000) return 'tired';
  // "Starved": < half of the user's average.
  if (m.weekAvgTokens > 0 && y < m.weekAvgTokens * 0.5) return 'meh';
  // Milestone day always reads as happy regardless of absolute scale.
  if (m.milestonesCrossed.length > 0) return 'happy';
  return y >= 5_000 ? 'happy' : 'meh';
}

function describeYesterday(n: number): string {
  if (n === 0)        return '一整天没吃东西';
  if (n < 500)        return '吃了一小口';
  if (n < 5_000)      return '勉强吃饱';
  if (n < 50_000)     return '吃得挺满足';
  if (n < 500_000)    return '吃得有点撑';
  return '撑到快爆炸';
}

function describeCompare(y: number, dayBefore: number): string {
  if (dayBefore === 0) return '前天没数据，没法比';
  const pct = (y - dayBefore) / dayBefore;
  if (pct > 0.5)  return '比前天多了一大截';
  if (pct > 0.1)  return '比前天稍多';
  if (pct < -0.5) return '比前天少了好多';
  if (pct < -0.1) return '比前天少了一点';
  return '和前天差不多';
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const TEMPLATES: Record<Mood, string[]> = {
  happy: [
    '${name}今天{compare}，{describe}。该说不说，主人这一天还算靠谱，没让我饿到怀疑人生。明天再接再厉。',
    '难得有这么舒服的一天。我{describe}，{compare}。坐在桌上看主人和键盘鏖战，竟然有点感动。',
    '${name}睡前记一笔：{describe}。{compare}，所以心情不错。希望明天也有这种节奏，别突然摆烂。',
    '昨天{describe}，{compare}。我趴在窗边看了一下午光斑，主人偶尔抬头看我一眼，挺好的。',
    '${name}吃到打嗝。{describe}，{compare}。这样的日子要是能多几天，我可能会胖到滚下桌。',
    '回想起来，昨天{describe}。{compare}，没什么大事，只是一种慢慢被填满的踏实感。',
    '${name}对昨天还算满意。{describe}，{compare}。算得上是个稳稳当当的日子。',
  ],
  tired: [
    '${name}觉得有点撑。{describe}，{compare}。主人是不是又通宵了？这样下去我吃不动了你也写不动。',
    '昨天{describe}。{compare}，吃到最后已经麻木。我趴在屏幕角落看会话一个接一个地开，有点晕。',
    '${name}写在日记本上：{describe}。{compare}。这不是夸你，主人，这是替你担心。',
    '吃太多了。{describe}，{compare}。我决定今天稍微少吃点，主人也该缓一缓。',
    '${name}撑得动不了。{describe}，{compare}。窗外的天好像也是阴的，配这种饱腹感正好。',
    '回顾昨天，只有"暴饮暴食"四个字配得上。{describe}，{compare}。明天我们都温柔一点。',
  ],
  angry: [
    '${name}饿了一整天。一口都没有。主人你昨天是去度假了还是把我忘了？',
    '空空的胃，空空的日记。{compare}（虽然根本没东西可比）。我决定记仇。',
    '昨天主人完全没理我。零，鸭蛋，颗粒无收。${name}很生气，后果不知道有多严重。',
    '没吃就没吃吧。${name}假装不在意，其实日记里全是怨气。',
    '一整天望着光标，光标也望着我，谁都不动。这是哪门子陪伴啊。',
    '${name}决定明天不主动撒娇了。看主人良心发现的速度。',
  ],
  meh: [
    '${name}觉得昨天平平。{describe}，{compare}。没什么值得写的，但还是写一笔，免得自己忘了活着。',
    '昨天{describe}。{compare}。主人忙他的，我看我的窗外，井水不犯河水。',
    '${name}觉得日子像温水。{describe}，{compare}。倒也不是不好。',
    '记一句流水账：{describe}，{compare}。今天的天气也是这种感觉。',
    '${name}懒得评价。{describe}。{compare}。明天再说吧。',
    '昨天{describe}。{compare}。没有特别的好，也没有特别的差，刚刚好用来发呆。',
  ],
};

/**
 * Render a template-driven journal body. Returns the body text plus the
 * weather emoji picked for the chosen mood. Caller writes the full
 * frontmatter via writeJournal — this function only owns the prose.
 */
export function renderTemplateJournal(
  meta: JournalDailyMetadata,
  petName: string,
): { body: string; weather: string } {
  const mood = pickMood(meta);
  const tpl = pickRandom(TEMPLATES[mood]);
  const body = tpl
    .replaceAll('${name}', petName)
    .replaceAll('{describe}', describeYesterday(meta.yesterdayTokens))
    .replaceAll('{compare}', describeCompare(meta.yesterdayTokens, meta.dayBeforeTokens));
  const weather = pickRandom(WEATHER_BY_MOOD[mood]);
  return { body, weather };
}
