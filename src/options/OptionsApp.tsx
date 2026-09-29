// Options Page — voice roster, pace, delivery, and the speak shortcut.
// The page is laid out as a type specimen sheet: a masthead, a running index,
// and numbered sections divided by hairline rules rather than nested cards.

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Check,
  ChevronDown,
  MicOff,
  Play,
  Search,
  Square,
} from 'lucide-react';
import { getSettings, setSettings, onSettingsChange, TTSSettings } from '../shared/storage';
import { VoiceInfo, DEFAULT_SETTINGS } from '../shared/types';

const VERSION = '1.0.9';
const PREVIEW_TEXT = 'The quick brown fox jumps over the lazy dog.';
const COMMAND_NAME = 'speak-selection';
const RECORDING_TIMEOUT_MS = 5000;
const SHORTCUT_UPDATE_TIMEOUT_MS = 2500;
/** Rough conversational pace at rate 1.0, used only to give the rate slider a real unit. */
const BASE_WPM = 165;
/** Range the cadence strip is clamped to so a single long pause cannot blow up the layout. */
const CADENCE_MIN_GAP = 4;
const CADENCE_MAX_GAP = 96;

// Signals that a voice sounds like a modern neural engine rather than a legacy formant synth.
const NATURAL_KEYWORDS = [
  'neural',
  'enhanced',
  'premium',
  'google',
  'microsoft',
  'siri',
  'whisper',
  'sonia',
  'aria',
  'jenny',
  'guy',
  'zira',
  'hazel',
  'wave',
  'eloquence',
];

// Legit but dated — usable, still not what we want to suggest by default.
const LOW_QUALITY_KEYWORDS = ['compact', 'espeak', 'pico', 'festival', 'puppet'];

function scoreVoice(name: string, voiceURI: string): number {
  const hay = `${name} ${voiceURI}`.toLowerCase();
  let score = 0;
  for (const k of NATURAL_KEYWORDS) if (hay.includes(k)) score += 1;
  for (const k of LOW_QUALITY_KEYWORDS) if (hay.includes(k)) score -= 3;
  return score;
}

function baseLang(lang: string): string {
  return lang.split(/[-_]/)[0].toLowerCase();
}

const LANG_LABELS: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  hi: 'Hindi',
  ar: 'Arabic',
  tr: 'Turkish',
  pl: 'Polish',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  nb: 'Norwegian',
  cs: 'Czech',
  el: 'Greek',
  he: 'Hebrew',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  uk: 'Ukrainian',
  ro: 'Romanian',
  hu: 'Hungarian',
};

// @types/chrome omits commands.update and commands.onChanged, both of which exist
// at runtime in the options page and are needed to keep the shortcut in sync.
type CommandsWithUpdate = {
  update: (
    info: { name: string; shortcut?: string },
    callback: () => void,
  ) => void;
  onChanged?: {
    addListener: (callback: () => void) => void;
    removeListener: (callback: () => void) => void;
  };
};

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '');

function prettyShortcut(shortcut: string): string {
  if (!shortcut) return 'Not set';
  return isMac
    ? shortcut.replace(/MacCtrl/g, '⌃').replace(/Ctrl/g, '⌃').replace(/Command/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥')
    : shortcut.replace(/Command/g, 'Ctrl').replace(/MacCtrl/g, 'Ctrl');
}

// Accepts native DOM events as well as React synthetic events so the recorder can
// listen on the document in the capture phase without duplicating the parser.
type ShortcutKeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

function normalizeShortcut(e: ShortcutKeyLike): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Command');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const key = e.key;
  const isModifier = ['Control', 'Meta', 'Alt', 'Shift', 'OS'].includes(key);
  if (isModifier) return null;

  // A bare letter/digit is too easy to trigger by accident — require a real chord.
  if (parts.length === 0) return null;

  const KEY_ALIASES: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
  };
  const normalized = KEY_ALIASES[key] ?? (key.length === 1 ? key.toUpperCase() : key);

  if (!/^(?:[A-Z0-9]$|F\d{1,2}$|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Esc|Plus|Comma|Period|Slash|Backslash|Semicolon|Quote|BracketLeft|BracketRight)$/.test(normalized)) {
    return null;
  }

  // Chrome rejects Ctrl+Alt+* (it is an AltGr-composition shortcut on Windows/Linux).
  if (parts.includes('Ctrl') && parts.includes('Alt')) return null;

  parts.push(normalized);
  return parts.join('+');
}

/** Word boundary times captured from a real utterance, relative to its start. */
type CadenceSample = { gapMs: number };

const RULE = 'border-[#34343A]';
const MUTED = 'text-[#9B968C]';

const Switch: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}> = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={`relative shrink-0 h-[18px] w-[34px] border transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5C29] ${
      checked ? 'border-[#FF5C29] bg-[#FF5C29]/20' : `border-[#34343A] bg-[#232327]`
    }`}
  >
    <span
      className={`absolute top-1/2 h-[10px] w-[10px] -translate-y-1/2 transition-all duration-150 ${
        checked ? 'left-[20px] bg-[#FF5C29]' : 'left-[3px] bg-[#9B968C]'
      }`}
    />
  </button>
);

// The native <select> renders an OS-styled light menu on Windows that ignores the
// dark page chrome, so the language filter is a real listbox instead.
const Dropdown: React.FC<{
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  label: string;
  className?: string;
}> = ({ value, options, onChange, label, className = '' }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const selected = options.find(o => o.value === value);

  const move = (delta: number) => {
    const index = options.findIndex(o => o.value === value);
    if (index < 0) return;
    const next = options[(index + delta + options.length) % options.length];
    if (next) onChange(next.value);
  };

  return (
    <div ref={wrapRef} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(v => !v)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) setOpen(true);
            else move(e.key === 'ArrowDown' ? 1 : -1);
          }
        }}
        className={`w-full flex items-center justify-between gap-2 px-3 h-9 text-left text-sm bg-[#232327] border ${RULE} text-[#EDEAE4] hover:border-[#9B968C]/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5C29] transition-colors`}
      >
        <span className="truncate">{selected?.label ?? label}</span>
        <ChevronDown
          size={13}
          strokeWidth={2}
          className={`shrink-0 ${MUTED} transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          className={`absolute z-30 mt-px w-full max-h-64 overflow-y-auto border ${RULE} bg-[#16161A] p-0`}
        >
          {options.map(option => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-active={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${
                  isSelected ? 'text-[#FF5C29] bg-[#FF5C29]/10' : 'text-[#EDEAE4]/80 hover:bg-[#232327]'
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <Check size={13} strokeWidth={2.5} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const SLIDER =
  'w-full h-px appearance-none bg-[#34343A] cursor-pointer ' +
  '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-[14px] [&::-webkit-slider-thumb]:w-[3px] ' +
  '[&::-webkit-slider-thumb]:bg-[#FF5C29] [&::-webkit-slider-thumb]:cursor-pointer ' +
  '[&::-moz-range-thumb]:h-[14px] [&::-moz-range-thumb]:w-[3px] [&::-moz-range-thumb]:border-0 ' +
  '[&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:bg-[#FF5C29]';

const Section: React.FC<{
  id: string;
  index: string;
  title: string;
  children: React.ReactNode;
}> = ({ id, index, title, children }) => (
  <section id={id} className={`scroll-mt-8 border-t ${RULE} pt-5`}>
    <div className="grid gap-x-10 gap-y-4 md:grid-cols-[10.5rem_minmax(0,1fr)]">
      <div className="md:pt-1">
        <h2 className={`font-mono text-[11px] uppercase tracking-[0.2em] ${MUTED}`}>
          <span className="text-[#FF5C29]">{index}</span> {title}
        </h2>
      </div>
      <div>{children}</div>
    </div>
  </section>
);

/**
 * Renders the word cadence the engine actually produced, taken from the
 * `boundary` events of a live utterance. The distance between ticks is the real
 * inter-word gap, so an uneven voice is visible rather than asserted.
 */
const CadenceTrace: React.FC<{ samples: CadenceSample[]; running: boolean }> = ({ samples, running }) => {
  if (samples.length === 0) {
    return (
      <p className={`font-mono text-[11px] ${MUTED}`}>
        {running ? 'awaiting boundary events…' : 'this voice reported no word boundaries'}
      </p>
    );
  }

  const gaps = samples.map(s => s.gapMs).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];

  return (
    <div>
      <div className="flex items-center h-[22px] overflow-hidden">
        {samples.map((sample, i) => (
          <span
            key={i}
            title={`${Math.round(sample.gapMs)} ms`}
            className="h-[22px] w-px shrink-0 bg-[#9B968C]/45"
            style={{ marginRight: `${Math.min(Math.max(sample.gapMs, CADENCE_MIN_GAP), CADENCE_MAX_GAP)}px` }}
          />
        ))}
      </div>
      <p className={`mt-2 font-mono text-[11px] ${MUTED}`}>
        {samples.length + 1} words
        <span className="px-2 text-[#34343A]">|</span>Δ {Math.round(gaps[0])}–{Math.round(gaps[gaps.length - 1])} ms
        <span className="px-2 text-[#34343A]">|</span>median {Math.round(median)} ms
      </p>
    </div>
  );
};

export const OptionsApp: React.FC = () => {
  const [settings, setSettingsState] = useState<TTSSettings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState('');

  const [search, setSearch] = useState('');
  const [langFilter, setLangFilter] = useState('all');
  const [onlyNatural, setOnlyNatural] = useState(false);
  const [previewingURI, setPreviewingURI] = useState<string | null>(null);
  const [cadence, setCadence] = useState<CadenceSample[]>([]);

  const [shortcut, setShortcut] = useState('');
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState('');
  const [shortcutSaved, setShortcutSaved] = useState(false);
  const shortcutTimer = useRef<number | null>(null);
  const shortcutUpdateTimer = useRef<number | null>(null);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => {
    getSettings().then(s => {
      setSettingsState(s);
      setSelectedVoiceURI(s.voice);
    });
    const unsub = onSettingsChange(s => {
      setSettingsState(s);
      setSelectedVoiceURI(s.voice);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!window.speechSynthesis) {
      setLoadingVoices(false);
      return;
    }

    const loadVoices = () => {
      const allVoices = window.speechSynthesis.getVoices();
      if (allVoices.length === 0) {
        setLoadingVoices(true);
        return;
      }

      // Collapse exact duplicates: Windows exposes the same voice under several URIs.
      const byURI = new Map<string, VoiceInfo>();
      for (const v of allVoices) {
        if (!v.voiceURI || byURI.has(v.voiceURI)) continue;
        byURI.set(v.voiceURI, {
          name: v.name,
          lang: v.lang,
          voiceURI: v.voiceURI,
          localService: v.localService,
          isNatural: scoreVoice(v.name, v.voiceURI) > 0,
        });
      }

      const parsed = [...byURI.values()];
      parsed.sort((a, b) => {
        const qa = scoreVoice(a.name, a.voiceURI);
        const qb = scoreVoice(b.name, b.voiceURI);
        if (qa !== qb) return qb - qa;
        const la = baseLang(a.lang);
        const lb = baseLang(b.lang);
        if (la !== lb) return la.localeCompare(lb);
        return a.name.localeCompare(b.name);
      });

      setVoices(parsed);
      setLoadingVoices(false);
    };

    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, []);

  // Read the live shortcut so the recorder shows reality, not the manifest default.
  const readShortcut = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.commands) return;
    chrome.commands.getAll(commands => {
      const cmd = commands.find(c => c.name === COMMAND_NAME);
      setShortcut(cmd?.shortcut ?? '');
    });
  }, []);

  // Stay in sync when the shortcut is changed from chrome://extensions/shortcuts,
  // where Chrome will happily accept combinations our own validator rejects.
  useEffect(() => {
    readShortcut();
    const onChanged = (chrome.commands as unknown as CommandsWithUpdate | undefined)?.onChanged;
    if (!onChanged) return;
    onChanged.addListener(readShortcut);
    return () => onChanged.removeListener(readShortcut);
  }, [readShortcut]);

  const handleSettingChange = useCallback(async (partial: Partial<TTSSettings>) => {
    const next = { ...settings, ...partial };
    setSettingsState(next);
    await setSettings(partial);
  }, [settings]);

  const handleVoiceChange = useCallback(
    async (voiceURI: string) => {
      setSelectedVoiceURI(voiceURI);
      await handleSettingChange({ voice: voiceURI });
    },
    [handleSettingChange],
  );

  const handleRateChange = useCallback(
    async (rate: number) => {
      await handleSettingChange({ rate });
    },
    [handleSettingChange],
  );

  const handleGapChange = useCallback(
    async (gap: number) => {
      await handleSettingChange({ sentenceGap: gap });
    },
    [handleSettingChange],
  );

  const handlePauseToggle = useCallback(
    async (checked: boolean) => {
      await handleSettingChange({ pauseOnPunctuation: checked });
    },
    [handleSettingChange],
  );

  const stopPreview = useCallback(() => {
    window.speechSynthesis?.cancel();
    setPreviewingURI(null);
  }, []);

  const previewVoice = useCallback(
    (voiceURI: string) => {
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (previewingURI === voiceURI) {
        stopPreview();
        return;
      }
      synth.cancel();
      const u = new SpeechSynthesisUtterance(PREVIEW_TEXT);
      u.voice = synth.getVoices().find(v => v.voiceURI === voiceURI) ?? null;
      u.rate = settings.rate;
      u.lang = baseLang(u.voice?.lang ?? 'en');

      // Boundary events are the only honest source for the cadence strip below.
      let lastAt: number | null = null;
      const startedAt = performance.now();
      setCadence([]);
      u.onboundary = () => {
        const now = performance.now();
        setCadence(prev =>
          lastAt === null
            ? prev
            : [...prev, { gapMs: now - lastAt }],
        );
        lastAt = now;
      };

      const finish = () => {
        setPreviewingURI(cur => (cur === voiceURI ? null : cur));
        // Trailing gap closes the final interval of the run.
        setCadence(prev =>
          lastAt === null || prev.length === 0
            ? prev
            : [...prev, { gapMs: Math.max(performance.now() - startedAt, 1) }],
        );
      };
      u.onend = finish;
      u.onerror = finish;

      setPreviewingURI(voiceURI);
      synth.speak(u);
    },
    [previewingURI, settings.rate, stopPreview],
  );

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const languages = useMemo(() => {
    const set = new Set(voices.map(v => baseLang(v.lang)));
    return [...set].sort();
  }, [voices]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return voices.filter(v => {
      if (onlyNatural && !v.isNatural) return false;
      if (langFilter !== 'all' && baseLang(v.lang) !== langFilter) return false;
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        v.lang.toLowerCase().includes(q) ||
        (LANG_LABELS[baseLang(v.lang)] ?? '').toLowerCase().includes(q)
      );
    });
  }, [voices, search, langFilter, onlyNatural]);

  const selectedVoice = useMemo(
    () => voices.find(v => v.voiceURI === selectedVoiceURI) ?? null,
    [voices, selectedVoiceURI],
  );

  const pinnedSelected = useMemo(() => {
    if (!selectedVoice) return null;
    // Only pin when the active voice still passes the current filters.
    return filtered.some(v => v.voiceURI === selectedVoice.voiceURI) ? selectedVoice : null;
  }, [filtered, selectedVoice]);

  const grouped = useMemo(() => {
    const map = new Map<string, VoiceInfo[]>();
    for (const v of filtered) {
      if (selectedVoice && v.voiceURI === selectedVoice.voiceURI) continue;
      const key = baseLang(v.lang);
      const bucket = map.get(key);
      if (bucket) bucket.push(v);
      else map.set(key, [v]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, selectedVoice]);

  const languageOptions = useMemo(
    () => [
      { value: 'all', label: 'All languages' },
      ...languages.map(l => ({ value: l, label: LANG_LABELS[l] ?? l })),
    ],
    [languages],
  );

  const clearRecording = useCallback(() => {
    if (shortcutTimer.current !== null) {
      window.clearTimeout(shortcutTimer.current);
      shortcutTimer.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearRecording();
      if (shortcutUpdateTimer.current !== null) window.clearTimeout(shortcutUpdateTimer.current);
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [clearRecording],
  );

  const startRecording = useCallback(() => {
    setRecording(true);
    setShortcutError('');
    setShortcutSaved(false);
    clearRecording();
    shortcutTimer.current = window.setTimeout(() => {
      setRecording(false);
      shortcutTimer.current = null;
    }, RECORDING_TIMEOUT_MS);
  }, [clearRecording]);

  const saveShortcut = useCallback(
    (next: string) => {
      if (typeof chrome === 'undefined' || !chrome.commands) {
        setShortcutError('Shortcuts are only configurable in the browser.');
        return;
      }
      let settled = false;
      const settle = (message: string) => {
        if (settled) return;
        settled = true;
        clearRecording();
        if (shortcutUpdateTimer.current !== null) {
          window.clearTimeout(shortcutUpdateTimer.current);
          shortcutUpdateTimer.current = null;
        }
        // Re-read so the field always reflects what Chrome actually stored, even if it
        // silently dropped a combination it considers invalid.
        readShortcut();
        if (message) {
          setShortcutError(message);
          return;
        }
        setShortcutError('');
        setShortcutSaved(true);
        if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(() => {
          setShortcutSaved(false);
          savedTimer.current = null;
        }, 2500);
      };
      // Chrome never invokes the update callback when the page is closing, so bound the
      // wait rather than letting the button hang in its pending state forever.
      shortcutUpdateTimer.current = window.setTimeout(
        () => settle('Chrome did not confirm the change. Try again, or set it in Chrome shortcut settings.'),
        SHORTCUT_UPDATE_TIMEOUT_MS,
      );
      (chrome.commands as unknown as CommandsWithUpdate).update(
        { name: COMMAND_NAME, shortcut: next },
        () => {
          const err = chrome.runtime.lastError;
          settle(err ? `Chrome rejected that shortcut — ${err.message}` : '');
        },
      );
    },
    [clearRecording, readShortcut],
  );

  // Record on the document in the capture phase: a plain button-scoped onKeyDown misses
  // keys whenever focus drifts, and Chrome rejects shortcuts the page never saw.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(false);
        clearRecording();
        return;
      }
      const next = normalizeShortcut(event);
      if (!next) return;
      setRecording(false);
      clearRecording();
      saveShortcut(next);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [recording, clearRecording, saveShortcut]);

  const totalVoices = voices.length;
  const shownVoices = filtered.length;
  const estimatedWpm = Math.round(BASE_WPM * settings.rate);
  const previewing = previewingURI !== null;

  const renderVoiceRow = (voice: VoiceInfo) => {
    const isSelected = selectedVoiceURI === voice.voiceURI;
    const isPlaying = previewingURI === voice.voiceURI;
    return (
      <div
        key={voice.voiceURI}
        className={`group flex items-center gap-3 pl-2.5 pr-1 py-2.5 -ml-2.5 border-b ${RULE}/60 transition-colors ${
          isSelected ? 'bg-[#232327] border-l border-l-[#FF5C29]' : 'hover:bg-[#232327]/60'
        }`}
      >
        <button
          type="button"
          onClick={() => handleVoiceChange(voice.voiceURI)}
          aria-pressed={isSelected}
          className="flex-1 min-w-0 flex items-center gap-3 text-left focus:outline-none"
        >
          <div className="min-w-0 flex-1">
            <p className={`text-sm truncate ${isSelected ? 'text-[#FF5C29]' : 'text-[#EDEAE4]'}`}>
              {voice.name}
            </p>
            <p className={`font-mono text-[11px] truncate ${MUTED}`}>{voice.lang}</p>
          </div>
        </button>

        <div className="flex items-center gap-2 shrink-0">
          {voice.isNatural && (
            <span className="font-mono text-[10px] tracking-[0.14em] text-[#FF5C29]">BEST</span>
          )}
          {voice.localService && (
            <span className={`font-mono text-[10px] tracking-[0.14em] ${MUTED}`}>LOCAL</span>
          )}
          <button
            type="button"
            onClick={() => previewVoice(voice.voiceURI)}
            aria-label={`${isPlaying ? 'Stop' : 'Preview'} ${voice.name}`}
            className={`w-7 h-7 flex items-center justify-center border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5C29] ${
              isPlaying ? 'border-[#FF5C29] text-[#FF5C29]' : `border-[#34343A] ${MUTED} hover:text-[#FF5C29]`
            }`}
          >
            {isPlaying ? (
              <Square size={10} strokeWidth={3} />
            ) : (
              <Play size={11} strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#0B0B0C] text-[#EDEAE4] font-sans">
      <header>
        <div className="mx-auto w-full max-w-[76rem] px-6 lg:px-10 pt-14 pb-10">
          <p className={`font-mono text-[11px] uppercase tracking-[0.24em] ${MUTED}`}>
            Selection reader
          </p>
          <h1 className="mt-3 font-serif text-[4.5rem] sm:text-[6rem] leading-[0.9] tracking-[-0.02em] text-[#EDEAE4]">
            Larynx
          </h1>
          <p className="mt-4 max-w-[34rem] text-[15px] leading-relaxed text-[#EDEAE4]/70">
            Select any passage in the browser and it is read aloud, one word at a time,
            with the current word inverted against the page behind it.
          </p>

          <dl className="mt-10 grid grid-cols-2 gap-px bg-[#34343A] border border-[#34343A] sm:grid-cols-4">
            {[
              { term: 'Engine', value: 'Web Speech API' },
              { term: 'Voices', value: loadingVoices ? 'loading…' : String(totalVoices) },
              { term: 'Pace', value: `${settings.rate.toFixed(2)}× · ${estimatedWpm} wpm` },
              { term: 'Version', value: `v${VERSION}` },
            ].map(item => (
              <div key={item.term} className="bg-[#0B0B0C] px-3 py-3">
                <dt className={`font-mono text-[10px] uppercase tracking-[0.18em] ${MUTED}`}>
                  {item.term}
                </dt>
                <dd className="mt-1 font-mono text-[13px] text-[#EDEAE4]">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[76rem] px-6 lg:px-10 pb-20">
        <div className="grid gap-x-10 lg:grid-cols-[10.5rem_minmax(0,1fr)]">
          <nav className="hidden lg:block py-10" aria-label="Sections">
            <ol className="sticky top-8 space-y-2 font-mono text-[11px] uppercase tracking-[0.2em]">
              {[
                { href: '#voice', label: '01 Voice' },
                { href: '#pace', label: '02 Pace' },
                { href: '#delivery', label: '03 Delivery' },
                { href: '#shortcut', label: '04 Shortcut' },
              ].map(item => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className={`block py-0.5 ${MUTED} transition-colors hover:text-[#EDEAE4] focus:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5C29]`}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="space-y-12 py-10">
            <Section id="voice" index="01" title="Voice">
              <p className={`text-sm leading-relaxed ${MUTED} mb-5 max-w-[42rem]`}>
                Choose the engine. Rows are ordered by quality, then by language. Press play on
                any row to hear the sample and watch its real word cadence.
              </p>

              {loadingVoices ? (
                <div className={`flex items-center gap-2 font-mono text-[12px] ${MUTED}`}>
                  <span className="inline-block w-3 h-3 border border-[#FF5C29] border-t-transparent animate-spin" />
                  Loading voices…
                </div>
              ) : totalVoices === 0 ? (
                <div className={`border ${RULE} px-4 py-8 text-center text-sm ${MUTED}`}>
                  <MicOff size={22} strokeWidth={1.5} className="mx-auto mb-2 opacity-50" />
                  No voices available. Voices load from the system Speech Synthesis API.
                </div>
              ) : (
                <>
                  <div className="flex flex-col sm:flex-row gap-2 mb-3">
                    <div className="relative flex-1">
                      <Search
                        size={13}
                        strokeWidth={2}
                        className={`absolute left-3 top-1/2 -translate-y-1/2 ${MUTED} pointer-events-none`}
                      />
                      <input
                        type="search"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search voices"
                        aria-label="Search voices"
                        className={`w-full pl-9 pr-3 h-9 text-sm bg-[#232327] border ${RULE} text-[#EDEAE4] placeholder:text-[#9B968C]/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5C29] transition-colors`}
                      />
                    </div>
                    <Dropdown
                      value={langFilter}
                      options={languageOptions}
                      onChange={setLangFilter}
                      label="Filter by language"
                      className="sm:w-44 w-full"
                    />
                    <button
                      type="button"
                      onClick={() => setOnlyNatural(v => !v)}
                      aria-pressed={onlyNatural}
                      className={`h-9 px-3 text-sm border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5C29] ${
                        onlyNatural
                          ? 'border-[#FF5C29] text-[#FF5C29] bg-[#FF5C29]/10'
                          : `border-[#34343A] bg-[#232327] ${MUTED} hover:text-[#EDEAE4]`
                      }`}
                    >
                      Best only
                    </button>
                  </div>

                  <p className={`font-mono text-[11px] mb-4 ${MUTED}`}>
                    Showing {shownVoices} of {totalVoices} voices
                  </p>

                  {shownVoices === 0 ? (
                    <div className={`border ${RULE} px-4 py-6 text-center text-sm ${MUTED}`}>
                      No voices match that filter.
                    </div>
                  ) : (
                    <div className="max-h-[30rem] overflow-y-auto pr-1">
                      {pinnedSelected && (
                        <div>
                          <p className={`sticky top-0 z-10 bg-[#0B0B0C]/95 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[#FF5C29]`}>
                            In use
                          </p>
                          <div className="border-t border-[#34343A]">{renderVoiceRow(pinnedSelected)}</div>
                        </div>
                      )}

                      {grouped.map(([lang, list]) => (
                        <div key={lang} className="mt-4">
                          <p className={`sticky top-0 z-10 bg-[#0B0B0C]/95 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] ${MUTED}`}>
                            {LANG_LABELS[lang] ?? lang} · {list.length}
                          </p>
                          <div className="border-t border-[#34343A]">
                            {list.map(renderVoiceRow)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className={`mt-6 border-t ${RULE} pt-4`}>
                    <p className={`font-mono text-[10px] uppercase tracking-[0.2em] ${MUTED} mb-2`}>
                      Cadence — “{PREVIEW_TEXT}”
                    </p>
                    <CadenceTrace samples={cadence} running={previewing} />
                  </div>
                </>
              )}
            </Section>

            <Section id="pace" index="02" title="Pace">
              <div className="max-w-[42rem]">
                <p className={`text-sm leading-relaxed ${MUTED} mb-5`}>
                  The Web Speech rate parameter. 1.00× is the voice’s own natural pace; the
                  words-per-minute figure is an estimate at that rate.
                </p>
                <div className="flex items-baseline justify-between mb-2">
                  <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#34343A]">
                    slow
                  </span>
                  <span className="font-mono text-[13px] text-[#EDEAE4]">
                    {settings.rate.toFixed(2)}×
                    <span className={`ml-2 text-[11px] ${MUTED}`}>≈ {estimatedWpm} wpm</span>
                  </span>
                  <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#34343A]">
                    fast
                  </span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.05"
                  value={settings.rate}
                  onChange={e => handleRateChange(parseFloat(e.target.value))}
                  aria-label="Speech rate"
                  className={SLIDER}
                />
                <div className={`mt-2 flex justify-between font-mono text-[10px] ${MUTED}`}>
                  <span>0.50×</span>
                  <span>1.00×</span>
                  <span>2.00×</span>
                </div>
              </div>
            </Section>

            <Section id="delivery" index="03" title="Delivery">
              <div className="max-w-[42rem] space-y-8">
                <div>
                  <div className="flex items-baseline justify-between mb-2">
                    <span className={`text-sm ${MUTED}`}>Pause between sentences</span>
                    <span className="font-mono text-[13px] text-[#EDEAE4]">
                      {settings.sentenceGap} ms
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1000"
                    step="50"
                    value={settings.sentenceGap}
                    onChange={e => handleGapChange(parseInt(e.target.value))}
                    aria-label="Sentence gap in milliseconds"
                    className={SLIDER}
                  />
                  <div className={`mt-2 flex justify-between font-mono text-[10px] ${MUTED}`}>
                    <span>0 ms</span>
                    <span>1000 ms</span>
                  </div>
                </div>

                <div className={`flex items-start justify-between gap-6 border-t ${RULE} pt-5`}>
                  <div>
                    <p className="text-sm text-[#EDEAE4]">Pause on punctuation</p>
                    <p className={`mt-1 text-sm leading-relaxed ${MUTED} max-w-[30rem]`}>
                      Lets the engine breathe at sentence boundaries instead of running
                      clauses together.
                    </p>
                  </div>
                  <Switch
                    checked={settings.pauseOnPunctuation}
                    onChange={handlePauseToggle}
                    label="Pause on punctuation"
                  />
                </div>
              </div>
            </Section>

            <Section id="shortcut" index="04" title="Shortcut">
              <div className="max-w-[42rem]">
                <p className={`text-sm leading-relaxed ${MUTED} mb-5`}>
                  Select text, then press the shortcut to read it. While a selection is being
                  read, the same shortcut pauses and resumes it.
                </p>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <p className="font-mono text-[13px] text-[#EDEAE4]">Speak selection</p>
                    <p className={`mt-1 text-[13px] ${MUTED}`}>
                      Press the field, then press a key combination.
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => (recording ? (setRecording(false), clearRecording()) : startRecording())}
                      className={`px-3 h-9 font-mono text-[12px] border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5C29] ${
                        recording
                          ? 'border-[#FF5C29] bg-[#FF5C29]/15 text-[#FF5C29]'
                          : `border-[#34343A] bg-[#232327] text-[#EDEAE4] hover:border-[#9B968C]/60`
                      }`}
                    >
                      {recording ? 'press keys…' : prettyShortcut(shortcut)}
                    </button>
                    {shortcut && !recording && (
                      <button
                        type="button"
                        onClick={() => saveShortcut(isMac ? 'Command+Shift+S' : 'Ctrl+Shift+S')}
                        className={`font-mono text-[11px] uppercase tracking-[0.14em] ${MUTED} hover:text-[#FF5C29] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5C29]`}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>

                {shortcutError && <p className="mt-3 text-[13px] text-[#FF5C29]">{shortcutError}</p>}
                {shortcutSaved && <p className={`mt-3 font-mono text-[11px] ${MUTED}`}>shortcut updated</p>}

                <p className={`mt-4 text-[13px] leading-relaxed ${MUTED}`}>
                  Chrome reserves some combinations. You can also change it in{' '}
                  <a
                    href="chrome://extensions/shortcuts"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#EDEAE4] underline decoration-[#34343A] underline-offset-4 hover:decoration-[#FF5C29]"
                  >
                    Chrome shortcut settings
                  </a>
                  .
                </p>
              </div>
            </Section>
          </div>
        </div>
      </main>

      <footer className={`border-t ${RULE}`}>
        <div className={`mx-auto w-full max-w-[76rem] px-6 lg:px-10 py-6 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] ${MUTED}`}>
          <span>Larynx v{VERSION}</span>
          <span>Local only — no audio leaves the browser</span>
        </div>
      </footer>
    </div>
  );
};

export function mountOptionsApp(root: HTMLElement) {
  const r = createRoot(root);
  r.render(<OptionsApp />);
  return r;
}
