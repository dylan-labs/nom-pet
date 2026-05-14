import React, { useEffect, useState } from 'react';
import type { NomApi } from '../../preload';
import type { LevelInfo, LlmSettings, NomSettings, SoulPreset } from '../../shared/types';

interface PresetMeta { id: Exclude<SoulPreset, 'custom'>; label: string; blurb: string; }
// Mirrors src/renderer/onboarding/App.tsx and src/main/data/soul.ts. Keep
// the three in sync (a tiny bit of duplication is fine for now; if it gets
// painful, lift this into a shared module).
const SOUL_PRESETS: PresetMeta[] = [
  { id: 'tsundere-architect', label: '傲娇前架构师', blurb: '阴阳怪气，看不起调用 AI 写代码的人' },
  { id: 'old-tcm-doctor',     label: '老中医爷爷',   blurb: '慢悠悠养生派，"虚火上升"挂嘴边' },
  { id: 'tang-concubine',     label: '阴阳大唐妃子', blurb: '半文半白，"哀家"上口，戏多' },
  { id: 'cursed-doll',        label: '邪典恐怖玩偶', blurb: '阴森低语，怨念附体' },
  { id: 'aloof-otaku',        label: '高冷死宅',     blurb: '社恐二次元中二台词' },
  { id: 'philosopher-stray',  label: '哲学家流浪猫', blurb: '存在主义馋猫' },
];

declare global {
  interface Window {
    nom: NomApi;
  }
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; ms: number; sample: string }
  | { kind: 'error'; message: string };

function formatTokens(n: number): string {
  if (n >= 1e15) return `${(n / 1e15).toFixed(1)}P`;
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function SettingsApp() {
  const [settings, setSettings] = useState<NomSettings | null>(null);
  const [level, setLevel] = useState<LevelInfo | null>(null);
  const [today, setToday] = useState(0);
  const [cumulative, setCumulative] = useState(0);

  // Local form state (decoupled from server settings until "保存")
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llmEndpoint, setLlmEndpoint] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [savedFlash, setSavedFlash] = useState(false);
  // Soul kernel form
  const [soulName, setSoulName] = useState('');
  const [soulPreset, setSoulPreset] = useState<SoulPreset | null>(null);
  const [soulSavedFlash, setSoulSavedFlash] = useState(false);

  useEffect(() => {
    void Promise.all([
      window.nom.getSettings(),
      window.nom.getLevel(),
      window.nom.getState(),
    ]).then(([s, l, snap]) => {
      setSettings(s);
      setLevel(l);
      setToday(snap.today);
      setCumulative(snap.cumulative);
      if (s.llm) {
        setLlmEnabled(s.llm.enabled);
        setLlmEndpoint(s.llm.endpoint);
        setLlmModel(s.llm.model);
        setLlmKey(s.llm.apiKey ?? '');
      }
      setSoulName(s.petName);
      // Snap to a valid preset if soul kernel exists; otherwise leave null
      // so the user can pick (and the button stays disabled until they do).
      setSoulPreset(s.soulKernel?.preset ?? null);
    });
  }, []);

  if (!settings) {
    return <div className="loading">加载中…</div>;
  }

  async function toggleSource(source: 'claudeCode' | 'codex', enabled: boolean) {
    const next = await window.nom.setSourceEnabled(source, enabled);
    setSettings(next);
  }

  async function toggleWander(enabled: boolean) {
    const next = await window.nom.setWanderEnabled(enabled);
    setSettings(next);
  }

  async function toggleAutonomy(enabled: boolean) {
    const next = await window.nom.setAutonomy({ enabled });
    setSettings(next);
  }

  function flashSaved() {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1800);
  }

  async function saveSoul() {
    const trimmedName = soulName.trim();
    if (trimmedName.length === 0 || soulPreset === null) return;
    // Reuse the onboarding-complete IPC: it already knows how to resolve
    // canonical preset text from soul.ts and writes name + kernel atomically.
    // It's idempotent — onboarded=true stays true on repeat calls.
    const next = await window.nom.completeOnboarding({
      petName: trimmedName,
      preset: soulPreset,
    });
    setSettings(next);
    setSoulSavedFlash(true);
    setTimeout(() => setSoulSavedFlash(false), 1800);
  }

  async function saveLlm() {
    const llm: LlmSettings | null = (llmEndpoint || llmModel || llmEnabled)
      ? {
          enabled: llmEnabled,
          endpoint: llmEndpoint.trim(),
          model: llmModel.trim(),
          apiKey: llmKey.trim() || null,
        }
      : null;
    const next = await window.nom.setLlmSettings(llm);
    setSettings(next);
    flashSaved();
  }

  async function runTest() {
    setTest({ kind: 'pending' });
    const result = await window.nom.testLlm({
      enabled: true,
      endpoint: llmEndpoint.trim(),
      model: llmModel.trim(),
      apiKey: llmKey.trim() || null,
    });
    if (result.ok) setTest({ kind: 'ok', ms: result.ms, sample: result.sample! });
    else setTest({ kind: 'error', message: result.error ?? '调用失败' });
  }

  const tierClass = level ? tierToClass(level.tier) : 'rookie';

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar-title">设置</span>
      </header>

      <main className="body">
        {/* Status card */}
        {level && (
          <section className="card status-card">
            <div className={`tier-chip tier--${tierClass}`}>
              <div className="tier-chip-tier">{level.tier}</div>
              {level.subLevel && <div className="tier-chip-sub">{level.subLevel}</div>}
            </div>
            <div className="status-meta">
              <div className="status-meta-row">
                <span className="status-label">累计</span>
                <span className="status-value">{formatTokens(cumulative)}</span>
              </div>
              <div className="status-meta-row">
                <span className="status-label">今日</span>
                <span className="status-value">{formatTokens(today)}</span>
              </div>
              {level.nextThreshold !== null && (
                <div className="progress">
                  <div className="progress-bar">
                    <div
                      className={`progress-fill tier--${tierClass}`}
                      style={{ width: `${Math.round(level.progress * 100)}%` }}
                    />
                  </div>
                  <div className="progress-label">
                    距离下一级还差 {formatTokens(level.nextThreshold - cumulative)}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Sources */}
        <section className="card">
          <div className="card-title">数据源</div>
          <Row label="Claude Code" sub="监听 ~/.claude/projects/*.jsonl">
            <Toggle checked={settings.sources.claudeCode} onChange={(v) => toggleSource('claudeCode', v)} />
          </Row>
          <Row label="Codex CLI" sub="监听 ~/.codex/sessions/**/*.jsonl">
            <Toggle checked={settings.sources.codex} onChange={(v) => toggleSource('codex', v)} />
          </Row>
          <div className="card-note">
            <strong>启动时会扫一遍历史 JSONL：</strong>近 7 天（毫秒级，让今日计数和昨日小结立刻有数据）+ 全量（后台跑，用来自愈丢失的等级 / 累计）。
            <strong>只读 <code>usage.*_tokens</code> 数字</strong>，不读 prompt / 回复，不写回任何目录，结果只存在 <code>~/.nom/state.json</code>。
          </div>
        </section>

        {/* Behavior */}
        <section className="card">
          <div className="card-title">行为</div>
          <Row label="自动游走" sub="闲置时宠物会自己在桌面溜达">
            <Toggle checked={settings.wanderEnabled} onChange={toggleWander} />
          </Row>
          <Row label="自主性（实验）" sub="开启后宠物每 30 分钟自己'想一下'，偶尔自发说话">
            <Toggle checked={settings.autonomy.enabled} onChange={toggleAutonomy} />
          </Row>
          {settings.autonomy.enabled && (
            <div className="card-note">
              <strong>宠物开始有自己的心情和小笔记了</strong>：记在 <code>~/.nom/pet-mind/</code>，你随时可以打开看。
              开启 AI 台词时，这些笔记（关于你近期行为的描述）会发到你配置的 LLM 端点 ——
              不开 AI 台词的话，宠物只默默记笔记，不说话。
            </div>
          )}
        </section>

        {/* Soul kernel — sit above AI 台词 because the soul precedes the mouth */}
        <section className="card">
          <div className="card-title">灵魂设定</div>
          <Field label="名字" placeholder="比如：大圣 / Mochi"
                 value={soulName} onChange={setSoulName} />
          <div className="preset-list">
            {SOUL_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`preset-row ${soulPreset === p.id ? 'preset-row--on' : ''}`}
                onClick={() => setSoulPreset(p.id)}
                type="button"
              >
                <span className={`preset-dot ${soulPreset === p.id ? 'preset-dot--on' : ''}`} />
                <span className="preset-meta">
                  <span className="preset-label">{p.label}</span>
                  <span className="preset-blurb">{p.blurb}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="card-footer">
            <span className={`saved-flash ${soulSavedFlash ? 'saved-flash--show' : ''}`}>已保存</span>
            <button
              className="btn btn-primary"
              onClick={saveSoul}
              disabled={soulName.trim().length === 0 || soulPreset === null}
            >
              保存灵魂
            </button>
          </div>
        </section>

        {/* LLM */}
        <section className="card">
          <div className="card-title">AI 台词</div>
          <Row label="启用" sub="接 OpenAI 协议端点，让台词上下文感知">
            <Toggle checked={llmEnabled} onChange={setLlmEnabled} />
          </Row>

          <div className={`llm-form ${llmEnabled ? '' : 'llm-form--dim'}`}>
            <Field label="Endpoint" placeholder="https://api.openai.com/v1/chat/completions"
                   value={llmEndpoint} onChange={setLlmEndpoint} />
            <Field label="Model" placeholder="gpt-4o-mini"
                   value={llmModel} onChange={setLlmModel}
                   hint={
                     <>
                       建议选 <code>mini</code> / <code>chat</code> / <code>instruct</code> 类的快速模型。
                       Thinking 类（<code>o1</code> / <code>r1</code> / <code>M2</code> / <code>qwq</code>）会先思考再回答，宠物一句嘴碎话可能要等好几秒。
                     </>
                   } />
            <Field label="API Key" placeholder="可选 — 不需要鉴权可留空" type="password"
                   value={llmKey} onChange={setLlmKey} />

            <div className="test-row">
              <button className="btn btn-secondary" onClick={runTest}
                      disabled={!llmEndpoint || !llmModel || test.kind === 'pending'}>
                {test.kind === 'pending' ? '测试中…' : '测试连接'}
              </button>
              {test.kind === 'ok' && (
                <span className="test-result test-result--ok">
                  ✓ 联通 · {test.ms}ms · "{test.sample.slice(0, 30)}{test.sample.length > 30 ? '…' : ''}"
                </span>
              )}
              {test.kind === 'error' && (
                <span className="test-result test-result--err">✗ {test.message}</span>
              )}
            </div>
          </div>

          <div className="card-footer">
            <span className={`saved-flash ${savedFlash ? 'saved-flash--show' : ''}`}>已保存</span>
            <button className="btn btn-primary" onClick={saveLlm}>保存 AI 配置</button>
          </div>
        </section>

        <footer className="hint">
          所有设置都存在 <code>~/.nom/state.json</code>，
          可以随时 <code>rm -rf ~/.nom</code> 完全重置。
        </footer>
      </main>
    </div>
  );
}

function Row({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-label">{label}</div>
        {sub && <div className="row-sub">{sub}</div>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`toggle ${checked ? 'toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function Field({
  label, placeholder, value, onChange, type = 'text', hint,
}: {
  label: string; placeholder?: string; value: string;
  onChange: (v: string) => void; type?: 'text' | 'password';
  hint?: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="field-input"
        type={type}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function tierToClass(tier: string): string {
  switch (tier) {
    case '新手': return 'rookie';
    case '学徒': return 'apprentice';
    case '行家': return 'expert';
    case '大师': return 'master';
    case '宗师': return 'grandmaster';
    case '传说': return 'legend';
    case '战神': return 'godlike';
    default:     return 'rookie';
  }
}
