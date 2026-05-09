import React, { useEffect, useState } from 'react';
import type { NomApi } from '../../preload';
import type { LevelInfo, LlmSettings, NomSettings } from '../../shared/types';

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

  function flashSaved() {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1800);
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
        </section>

        {/* Behavior */}
        <section className="card">
          <div className="card-title">行为</div>
          <Row label="自动游走" sub="闲置时宠物会自己在桌面溜达">
            <Toggle checked={settings.wanderEnabled} onChange={toggleWander} />
          </Row>
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
                   value={llmModel} onChange={setLlmModel} />
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
  label, placeholder, value, onChange, type = 'text',
}: {
  label: string; placeholder?: string; value: string;
  onChange: (v: string) => void; type?: 'text' | 'password';
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
