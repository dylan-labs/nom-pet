import React, { useState } from 'react';
import type { NomApi } from '../../preload';
import type { SoulPreset } from '../../shared/types';

declare global {
  interface Window {
    nom: NomApi;
  }
}

interface PresetOption {
  id: Exclude<SoulPreset, 'custom'>;
  label: string;
  blurb: string;     // one-line teaser shown next to the radio
}

// Mirror src/main/data/soul.ts PRESETS, but keep the displayed blurbs
// short — the canonical text is much longer and serves as the actual
// prompt injection, while this is just UX flavour.
const PRESETS: PresetOption[] = [
  { id: 'tsundere-architect', label: '傲娇前架构师', blurb: '阴阳怪气，看不起调用 AI 写代码的人，但偷偷享受被喂' },
  { id: 'old-tcm-doctor',     label: '老中医爷爷',   blurb: '慢悠悠养生派，"虚火上升"挂嘴边' },
  { id: 'tang-concubine',     label: '阴阳大唐妃子', blurb: '半文半白，"哀家"上口，戏多' },
  { id: 'cursed-doll',        label: '邪典恐怖玩偶', blurb: '阴森低语，怨念附体，但其实只想被喂饱' },
  { id: 'aloof-otaku',        label: '高冷死宅',     blurb: '社恐二次元中二台词，看不起 3D 人类' },
  { id: 'philosopher-stray',  label: '哲学家流浪猫', blurb: '存在主义馋猫，token 即流逝' },
];

export function OnboardingApp() {
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<SoulPreset | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nameValid = name.trim().length >= 1 && name.trim().length <= 20;
  const canSubmit = nameValid && preset !== null && !submitting;

  async function submit() {
    if (!canSubmit || preset === null) return;
    setSubmitting(true);
    try {
      await window.nom.completeOnboarding({
        petName: name.trim(),
        preset,
      });
      // main process closes this window + opens the pet — no further UI here.
    } catch (e) {
      console.error('[onboarding] failed:', e);
      setSubmitting(false);
    }
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar-title">欢迎来到 nom</span>
      </header>

      <main className="body">
        <section className="hero">
          <div className="hero-emoji">🐾</div>
          <div className="hero-lead">先给我起个名字，再决定我是怎样的灵魂。</div>
        </section>

        <section className="card">
          <label className="field">
            <span className="field-label">名字</span>
            <input
              className="field-input"
              type="text"
              placeholder="比如：大圣 / Mochi / 二狗"
              maxLength={20}
              value={name}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <span className="field-hint">2–20 字，中英数字都行。之后可以在设置里改。</span>
          </label>
        </section>

        <section className="card">
          <div className="card-title">人格内核</div>
          <div className="preset-list">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className={`preset-row ${preset === p.id ? 'preset-row--on' : ''}`}
                onClick={() => setPreset(p.id)}
                type="button"
              >
                <span className={`preset-dot ${preset === p.id ? 'preset-dot--on' : ''}`} />
                <span className="preset-meta">
                  <span className="preset-label">{p.label}</span>
                  <span className="preset-blurb">{p.blurb}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="card-foot-note">自定义人格留到 v0.0.23 的后半段开放（先用预设玩起来）。</div>
        </section>

        <div className="actions">
          <button
            className="btn btn-primary btn-large"
            onClick={submit}
            disabled={!canSubmit}
          >
            {submitting ? '保存中…' : '开始养我'}
          </button>
        </div>
      </main>
    </div>
  );
}
