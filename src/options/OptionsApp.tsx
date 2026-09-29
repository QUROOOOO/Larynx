// Options Page — Larynx Settings & Voice Studio
// Human-crafted, modern, accessible dark UI with tactile controls,
// live speech playground, calibrated pace slider, and instant shortcut recorder.

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Check,
  ChevronDown,
  Command,
  Headphones,
  Keyboard,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sliders,
  Sparkles,
  Volume2,
  Zap,
} from 'lucide-react';
import { getSettings, setSettings, onSettingsChange, TTSSettings } from '../shared/storage';
import { VoiceInfo, DEFAULT_SETTINGS } from '../shared/types';
import { splitIntoSentences } from '../shared/text-utils';

const VERSION = '1.0.9';
const COMMAND_NAME = 'speak-selection';
const RECORDING_TIMEOUT_MS = 5000;
const SHORTCUT_UPDATE_TIMEOUT_MS = 2500;
const BASE_WPM = 165;

const DEFAULT_PLAYGROUND_TEXT =
  'Select any passage on the web and press your shortcut to hear it in a natural voice, with word-by-word highlighting.';

// Signals that a voice sounds like a modern neural/enhanced engine
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

function parseShortcutKeys(shortcut: string): string[] {
  if (!shortcut) return ['Not set'];
  const parts = shortcut.split('+');
  return parts.map((part) => {
    if (isMac) {
      if (part === 'Ctrl' || part === 'MacCtrl') return '⌃ Control';
      if (part === 'Command') return '⌘ Cmd';
      if (part === 'Alt') return '⌥ Option';
      if (part === 'Shift') return '⇧ Shift';
    } else {
      if (part === 'Command') return 'Ctrl';
    }
    return part;
  });
}

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

  if (
    !/^(?:[A-Z0-9]$|F\d{1,2}$|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Esc|Plus|Comma|Period|Slash|Backslash|Semicolon|Quote|BracketLeft|BracketRight)$/.test(
      normalized,
    )
  ) {
    return null;
  }

  if (parts.includes('Ctrl') && parts.includes('Alt')) return null;

  parts.push(normalized);
  return parts.join('+');
}

// --------------------------------------------------------------------------
// UI Components
// --------------------------------------------------------------------------

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
    className={`relative shrink-0 h-6 w-11 rounded-full border transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF5C29]/60 ${
      checked
        ? 'border-[#FF5C29] bg-[#FF5C29]'
        : 'border-white/10 bg-white/5 hover:border-white/20'
    }`}
  >
    <span
      className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-all duration-200 ${
        checked ? 'left-6' : 'left-1'
      }`}
    />
  </button>
);

const Dropdown: React.FC<{
  value: string;
  options: Array<{ value: string; label: string; count?: number }>;
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

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={wrapRef} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2.5 px-3.5 h-10 rounded-xl bg-[#141824] border border-white/10 text-white hover:border-white/25 focus:outline-none focus:ring-2 focus:ring-[#FF5C29]/40 transition-all text-sm font-medium"
      >
        <span className="truncate">{selected?.label ?? label}</span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-slate-400 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="absolute z-50 mt-1.5 w-full max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-[#121622] p-1.5 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150"
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                  isSelected
                    ? 'text-white bg-[#FF5C29] font-medium'
                    : 'text-slate-300 hover:bg-white/5 hover:text-white'
                }`}
              >
                <span className="truncate">{option.label}</span>
                {option.count !== undefined && (
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded-full ${
                      isSelected ? 'bg-white/20 text-white' : 'text-slate-400 bg-white/5'
                    }`}
                  >
                    {option.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
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

  // Playground state
  const [playgroundText, setPlaygroundText] = useState(DEFAULT_PLAYGROUND_TEXT);
  const [playgroundPlaying, setPlaygroundPlaying] = useState(false);
  const [playgroundActiveWordIndex, setPlaygroundActiveWordIndex] = useState<number | null>(null);
  const playgroundTokens = useMemo(() => playgroundText.match(/\S+/g) ?? [], [playgroundText]);

  // Shortcut recorder state
  const [shortcut, setShortcut] = useState('');
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState('');
  const [shortcutSaved, setShortcutSaved] = useState(false);
  const shortcutTimer = useRef<number | null>(null);
  const shortcutUpdateTimer = useRef<number | null>(null);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => {
    getSettings().then((s) => {
      setSettingsState(s);
      setSelectedVoiceURI(s.voice);
    });
    const unsub = onSettingsChange((s) => {
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

  const readShortcut = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.commands) return;
    chrome.commands.getAll((commands) => {
      const cmd = commands.find((c) => c.name === COMMAND_NAME);
      setShortcut(cmd?.shortcut ?? '');
    });
  }, []);

  useEffect(() => {
    readShortcut();
    const onChanged = (chrome.commands as unknown as CommandsWithUpdate | undefined)?.onChanged;
    if (!onChanged) return;
    onChanged.addListener(readShortcut);
    return () => onChanged.removeListener(readShortcut);
  }, [readShortcut]);

  const handleSettingChange = useCallback(
    async (partial: Partial<TTSSettings>) => {
      const next = { ...settings, ...partial };
      setSettingsState(next);
      await setSettings(partial);
    },
    [settings],
  );

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

  // Stop any active speech
  const stopAudio = useCallback(() => {
    window.speechSynthesis?.cancel();
    setPreviewingURI(null);
    setPlaygroundPlaying(false);
    setPlaygroundActiveWordIndex(null);
  }, []);

  const previewVoice = useCallback(
    (voiceURI: string) => {
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (previewingURI === voiceURI) {
        stopAudio();
        return;
      }
      stopAudio();

      const voice = synth.getVoices().find((v) => v.voiceURI === voiceURI) ?? null;
      const u = new SpeechSynthesisUtterance('The quick brown fox jumps over the lazy dog.');
      if (voice) u.voice = voice;
      u.rate = settings.rate;

      u.onend = () => setPreviewingURI(null);
      u.onerror = () => setPreviewingURI(null);

      setPreviewingURI(voiceURI);
      synth.speak(u);
    },
    [previewingURI, settings.rate, stopAudio],
  );

  // Playground interactive speaker with live word-by-word visual highlight!
  const togglePlayground = useCallback(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (playgroundPlaying) {
      stopAudio();
      return;
    }
    stopAudio();

    if (!playgroundText.trim()) return;

    const sentences = splitIntoSentences(playgroundText);
    if (sentences.length === 0) return;

    setPlaygroundPlaying(true);
    setPlaygroundActiveWordIndex(0);

    const voice = selectedVoiceURI
      ? synth.getVoices().find((v) => v.voiceURI === selectedVoiceURI) ?? null
      : null;

    let globalWordOffset = 0;
    let sentenceIdx = 0;

    const speakNextSentence = () => {
      if (sentenceIdx >= sentences.length) {
        setPlaygroundPlaying(false);
        setPlaygroundActiveWordIndex(null);
        return;
      }

      const sentence = sentences[sentenceIdx];
      const sentenceWords = sentence.match(/\S+/g) ?? [];
      const u = new SpeechSynthesisUtterance(sentence);
      if (voice) u.voice = voice;
      u.rate = settings.rate;

      // Tokenize offsets for word tracking
      const pattern = /\S+/g;
      const offsets: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(sentence)) !== null) {
        offsets.push(m.index);
      }

      const currentOffset = globalWordOffset;
      let timer: ReturnType<typeof setInterval> | null = null;
      let localIndex = -1;

      const baseMs = 360 / settings.rate;
      let nextWordAt = Date.now();

      const stepPump = () => {
        if (localIndex >= sentenceWords.length - 1) {
          if (timer) clearInterval(timer);
          return;
        }
        if (Date.now() >= nextWordAt) {
          localIndex++;
          setPlaygroundActiveWordIndex(currentOffset + localIndex);
          const w = sentenceWords[localIndex] || '';
          const factor = Math.max(0.65, Math.min(1.75, (w.length + 1) / 5));
          nextWordAt = Date.now() + Math.round(baseMs * factor);
        }
      };

      u.onstart = () => {
        localIndex = -1;
        nextWordAt = Date.now();
        timer = setInterval(stepPump, 20);
      };

      u.onboundary = (e) => {
        const ev = e as SpeechSynthesisEvent;
        if (ev.name && ev.name !== 'word') return;
        const charIdx = ev.charIndex;
        if (typeof charIdx === 'number' && offsets.length > 0) {
          let found = 0;
          for (let i = 0; i < offsets.length; i++) {
            if (offsets[i] <= charIdx) found = i;
            else break;
          }
          localIndex = found;
          setPlaygroundActiveWordIndex(currentOffset + localIndex);
          const w = sentenceWords[localIndex] || '';
          const factor = Math.max(0.65, Math.min(1.75, (w.length + 1) / 5));
          nextWordAt = Date.now() + Math.round(baseMs * factor);
        }
      };

      u.onend = () => {
        if (timer) clearInterval(timer);
        globalWordOffset += sentenceWords.length;
        sentenceIdx++;
        if (settings.pauseOnPunctuation && settings.sentenceGap > 0) {
          setTimeout(speakNextSentence, settings.sentenceGap);
        } else {
          speakNextSentence();
        }
      };

      u.onerror = () => {
        if (timer) clearInterval(timer);
        setPlaygroundPlaying(false);
        setPlaygroundActiveWordIndex(null);
      };

      synth.speak(u);
    };

    speakNextSentence();
  }, [playgroundPlaying, playgroundText, selectedVoiceURI, settings, stopAudio]);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  // Filtered voice roster
  const languages = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of voices) {
      const code = baseLang(v.lang);
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [voices]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return voices.filter((v) => {
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
    () => voices.find((v) => v.voiceURI === selectedVoiceURI) ?? null,
    [voices, selectedVoiceURI],
  );

  const languageOptions = useMemo(
    () => [
      { value: 'all', label: 'All Languages', count: voices.length },
      ...languages.map(([l, count]) => ({
        value: l,
        label: LANG_LABELS[l] ?? l.toUpperCase(),
        count,
      })),
    ],
    [languages, voices.length],
  );

  // Shortcut recorder handlers
  const clearRecording = useCallback(() => {
    if (shortcutTimer.current !== null) {
      window.clearTimeout(shortcutTimer.current);
      shortcutTimer.current = null;
    }
  }, []);

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
        setShortcutError('Shortcuts can only be assigned in Chrome extensions mode.');
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

      shortcutUpdateTimer.current = window.setTimeout(
        () => settle('Chrome did not confirm the change. Try again or edit in Chrome shortcuts.'),
        SHORTCUT_UPDATE_TIMEOUT_MS,
      );

      (chrome.commands as unknown as CommandsWithUpdate).update(
        { name: COMMAND_NAME, shortcut: next },
        () => {
          const err = chrome.runtime.lastError;
          settle(err ? `Chrome rejected shortcut: ${err.message}` : '');
        },
      );
    },
    [clearRecording, readShortcut],
  );

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

  // Accurate Slider percentage for Pace (min=0.5, max=2.0)
  const pacePercentage = ((settings.rate - 0.5) / (2.0 - 0.5)) * 100;
  const estimatedWpm = Math.round(BASE_WPM * settings.rate);

  return (
    <div className="min-h-screen bg-[#090A0F] text-white font-sans selection:bg-[#FF5C29]/30 selection:text-white">
      {/* Background ambient lighting */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[350px] bg-[#FF5C29]/10 rounded-full blur-[140px]" />
        <div className="absolute top-1/3 -left-40 w-[450px] h-[450px] bg-indigo-600/5 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-4xl px-5 sm:px-8 py-10 sm:py-14 space-y-8">
        {/* Header Bar */}
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6 pb-6 border-b border-white/[0.08]">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#FF5C29] via-[#FF6E3D] to-[#FF8A54] flex items-center justify-center shadow-lg shadow-[#FF5C29]/25 shrink-0 ring-1 ring-white/20">
              <Volume2 size={24} className="text-white" strokeWidth={2.5} />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-2xl font-bold tracking-tight text-white">Larynx</h1>
                <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded-full bg-[#FF5C29]/15 text-[#FF5C29] border border-[#FF5C29]/30">
                  v{VERSION}
                </span>
                <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <Zap size={11} /> On-Device
                </span>
              </div>
              <p className="text-sm text-slate-400 mt-0.5">
                Instant, natural text-to-speech with live word-by-word highlighting.
              </p>
            </div>
          </div>

          {/* Quick status badges */}
          <div className="flex items-center gap-2 bg-[#121622] border border-white/[0.08] px-3.5 py-2 rounded-xl text-xs text-slate-300 shadow-sm self-start sm:self-auto">
            <span className="flex items-center gap-1.5 text-slate-400">
              <Headphones size={13} className="text-[#FF5C29]" />
              {selectedVoice ? selectedVoice.name.split('-')[0].trim() : 'System Voice'}
            </span>
            <span className="text-white/20">|</span>
            <span className="font-mono text-[#FF5C29] font-medium">{settings.rate.toFixed(2)}×</span>
            <span className="text-white/20">|</span>
            <span className="font-mono text-slate-300 font-medium">{shortcut || 'Ctrl+Shift+S'}</span>
          </div>
        </header>

        {/* ---------------------------------------------------------------- */}
        {/* INTERACTIVE PLAYGROUND (Test Bench)                             */}
        {/* ---------------------------------------------------------------- */}
        <section className="rounded-2xl bg-gradient-to-b from-[#131724] to-[#0E121D] border border-white/[0.08] p-6 shadow-xl relative overflow-hidden">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-[#FF5C29]" />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
                Interactive Test Bench
              </h2>
            </div>
            <span className="text-xs text-slate-400 font-medium">
              Click play to test your voice & live word highlighting
            </span>
          </div>

          {/* Interactive highlighted text frame */}
          <div className="min-h-[76px] p-4 rounded-xl bg-[#090B12] border border-white/[0.06] flex flex-wrap gap-x-1.5 gap-y-1.5 items-center leading-relaxed text-base">
            {playgroundTokens.map((token, i) => {
              const isActive = playgroundActiveWordIndex === i;
              return (
                <span
                  key={i}
                  className={`px-1 rounded transition-all duration-100 ${
                    isActive
                      ? 'bg-[#FF5C29] text-white shadow-md shadow-[#FF5C29]/40 ring-2 ring-[#FF5C29] font-medium scale-105'
                      : 'text-slate-200'
                  }`}
                >
                  {token}
                </span>
              );
            })}
          </div>

          <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-white/[0.06]">
            <input
              type="text"
              value={playgroundText}
              onChange={(e) => setPlaygroundText(e.target.value)}
              placeholder="Type any custom sentence to test..."
              className="flex-1 bg-[#161B29] border border-white/10 rounded-xl px-3.5 py-2 text-xs text-slate-300 placeholder:text-slate-500 focus:outline-none focus:border-[#FF5C29]/60 transition-colors"
            />
            <button
              type="button"
              onClick={togglePlayground}
              className={`flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold shadow-md transition-all shrink-0 ${
                playgroundPlaying
                  ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/30'
                  : 'bg-[#FF5C29] hover:bg-[#FF7043] text-white shadow-[#FF5C29]/30 hover:scale-[1.02]'
              }`}
            >
              {playgroundPlaying ? (
                <>
                  <Pause size={14} /> Stop Speech
                </>
              ) : (
                <>
                  <Play size={14} /> Listen & Watch Live
                </>
              )}
            </button>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* SECTION 1: VOICE ROSTER                                         */}
        {/* ---------------------------------------------------------------- */}
        <section className="rounded-2xl bg-[#11141E] border border-white/[0.08] p-6 shadow-xl space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-white/[0.06]">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Mic size={18} className="text-[#FF5C29]" />
                Voice & Pronunciation
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Choose the speech synthesis voice. Natural and neural voices are ranked highest.
              </p>
            </div>
            <span className="text-xs font-mono text-slate-400 bg-white/5 px-2.5 py-1 rounded-lg self-start sm:self-auto">
              {filtered.length} of {voices.length} voices
            </span>
          </div>

          {/* Search & Filter Bar */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search
                size={15}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search voices by name or language..."
                className="w-full pl-10 pr-4 h-10 rounded-xl bg-[#141824] border border-white/10 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-[#FF5C29]/60 transition-colors"
              />
            </div>

            <Dropdown
              value={langFilter}
              options={languageOptions}
              onChange={setLangFilter}
              label="Filter by Language"
              className="sm:w-52 w-full"
            />

            <button
              type="button"
              onClick={() => setOnlyNatural((v) => !v)}
              className={`h-10 px-4 rounded-xl text-xs font-semibold border transition-all shrink-0 flex items-center gap-1.5 ${
                onlyNatural
                  ? 'border-[#FF5C29] bg-[#FF5C29]/15 text-[#FF5C29]'
                  : 'border-white/10 bg-[#141824] text-slate-300 hover:text-white hover:border-white/20'
              }`}
            >
              <Sparkles size={13} />
              Best Voices Only
            </button>
          </div>

          {/* Voice Cards List */}
          {loadingVoices ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-slate-400">
              <div className="w-6 h-6 border-2 border-[#FF5C29] border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">Loading available system voices…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-slate-400 rounded-xl border border-dashed border-white/10">
              <MicOff size={24} className="mx-auto mb-2 opacity-40 text-slate-400" />
              <p className="text-sm font-medium">No voices match your search.</p>
              <p className="text-xs text-slate-500 mt-1">Try clearing filters or search terms.</p>
            </div>
          ) : (
            <div className="max-h-[340px] overflow-y-auto space-y-1.5 pr-1.5 custom-scrollbar">
              {filtered.map((voice) => {
                const isSelected = selectedVoiceURI === voice.voiceURI;
                const isPlaying = previewingURI === voice.voiceURI;
                const langName = LANG_LABELS[baseLang(voice.lang)] ?? voice.lang;

                return (
                  <div
                    key={voice.voiceURI}
                    className={`group flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition-all ${
                      isSelected
                        ? 'border-[#FF5C29]/60 bg-[#FF5C29]/10 shadow-sm shadow-[#FF5C29]/10 ring-1 ring-[#FF5C29]/30'
                        : 'border-white/[0.05] bg-[#141824]/60 hover:bg-[#141824] hover:border-white/10'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleVoiceChange(voice.voiceURI)}
                      className="flex-1 min-w-0 flex items-center gap-3 text-left focus:outline-none"
                    >
                      <div
                        className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                          isSelected
                            ? 'border-[#FF5C29] bg-[#FF5C29] text-white'
                            : 'border-white/20 group-hover:border-white/40'
                        }`}
                      >
                        {isSelected && <Check size={12} strokeWidth={3} />}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p
                            className={`text-sm font-medium truncate ${
                              isSelected ? 'text-white' : 'text-slate-200'
                            }`}
                          >
                            {voice.name}
                          </p>
                          {voice.isNatural && (
                            <span className="font-semibold text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-400 border border-amber-500/30">
                              Natural
                            </span>
                          )}
                          {voice.localService && (
                            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/5 text-slate-400">
                              Local
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {langName} <span className="text-slate-600">·</span>{' '}
                          <span className="font-mono text-[11px] text-slate-500">{voice.lang}</span>
                        </p>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => previewVoice(voice.voiceURI)}
                      title={isPlaying ? 'Stop Preview' : 'Listen to Sample'}
                      className={`h-8 px-3 rounded-lg flex items-center gap-1.5 text-xs font-semibold border transition-all shrink-0 ${
                        isPlaying
                          ? 'border-[#FF5C29] bg-[#FF5C29] text-white shadow-md shadow-[#FF5C29]/30'
                          : 'border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10'
                      }`}
                    >
                      {isPlaying ? (
                        <>
                          <Pause size={12} /> Playing…
                        </>
                      ) : (
                        <>
                          <Play size={12} /> Sample
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* SECTION 2: SPEECH PACE & SPEED (ACCURATELY CALIBRATED!)          */}
        {/* ---------------------------------------------------------------- */}
        <section className="rounded-2xl bg-[#11141E] border border-white/[0.08] p-6 shadow-xl space-y-6">
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-white/[0.06]">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Sliders size={18} className="text-[#FF5C29]" />
                Speech Pace & Speed
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Adjust how fast words are spoken. 1.00× represents the voice's default natural pace.
              </p>
            </div>
            {/* Live Accurate Rate Badge */}
            <div className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-[#FF5C29]/20 to-orange-500/10 border border-[#FF5C29]/30 text-right">
              <span className="text-base font-bold text-white font-mono">
                {settings.rate.toFixed(2)}×
              </span>
              <span className="block text-[11px] text-slate-400 font-mono">
                ≈ {estimatedWpm} words/min
              </span>
            </div>
          </div>

          {/* Slider with accurate fill and mathematically correct tick markers */}
          <div className="space-y-4 pt-1">
            <div className="relative flex items-center h-8">
              {/* Slider Track Background */}
              <div className="absolute left-0 right-0 h-2 rounded-full bg-[#181D2B] border border-white/5 overflow-hidden">
                {/* Active Fill Gradient */}
                <div
                  className="h-full bg-gradient-to-r from-[#FF5C29] to-[#FF854D] rounded-full transition-all duration-75"
                  style={{ width: `${pacePercentage}%` }}
                />
              </div>

              {/* Native range input positioned over track */}
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.05"
                value={settings.rate}
                onChange={(e) => handleRateChange(parseFloat(e.target.value))}
                aria-label="Speech rate"
                className="w-full absolute opacity-0 cursor-pointer h-8 z-20"
              />

              {/* Custom Thumb positioned at exact percentage */}
              <div
                className="absolute w-5 h-5 rounded-full bg-white shadow-md shadow-black/50 border-2 border-[#FF5C29] pointer-events-none -translate-x-1/2 z-10 transition-all duration-75"
                style={{ left: `${pacePercentage}%` }}
              />
            </div>

            {/* Mathematically Accurate Markers matching the 0.5 - 2.0 scale: */}
            {/* (0.5 = 0%, 0.75 = 16.7%, 1.0 = 33.3%, 1.25 = 50%, 1.5 = 66.7%, 2.0 = 100%) */}
            <div className="relative text-[11px] font-mono text-slate-400 h-6">
              <span className="absolute left-0 -translate-x-0">0.50× (Slow)</span>
              <button
                type="button"
                onClick={() => handleRateChange(1.0)}
                className="absolute left-[33.33%] -translate-x-1/2 flex flex-col items-center group cursor-pointer focus:outline-none"
              >
                <span className="w-1 h-1.5 rounded-full bg-[#FF5C29] mb-0.5 group-hover:scale-150 transition-transform" />
                <span className="font-bold text-[#FF5C29] group-hover:underline">1.00× (Normal)</span>
              </button>
              <span className="absolute left-[66.67%] -translate-x-1/2 hidden sm:inline">1.50×</span>
              <span className="absolute right-0 translate-x-0">2.00× (Fast)</span>
            </div>

            {/* Quick Speed Preset Buttons */}
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <span className="text-xs text-slate-400 font-medium mr-1">Presets:</span>
              {[
                { label: '0.80× Relaxed', val: 0.8 },
                { label: '1.00× Normal', val: 1.0 },
                { label: '1.25× Brisk', val: 1.25 },
                { label: '1.50× Fast', val: 1.5 },
                { label: '2.00× Rapid', val: 2.0 },
              ].map((p) => {
                const isSelected = Math.abs(settings.rate - p.val) < 0.01;
                return (
                  <button
                    key={p.val}
                    type="button"
                    onClick={() => handleRateChange(p.val)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                      isSelected
                        ? 'border-[#FF5C29] bg-[#FF5C29] text-white shadow-sm shadow-[#FF5C29]/30'
                        : 'border-white/10 bg-[#141824] text-slate-300 hover:text-white hover:border-white/20'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* SECTION 3: DELIVERY & PAUSES (NO CONFUSING DOUBLE LINES!)        */}
        {/* ---------------------------------------------------------------- */}
        <section className="rounded-2xl bg-[#11141E] border border-white/[0.08] p-6 shadow-xl space-y-6">
          <div className="pb-3 border-b border-white/[0.06]">
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              <Headphones size={18} className="text-[#FF5C29]" />
              Delivery & Sentence Breathing
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Control pause duration between sentences and punctuation breathing for effortless listening.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            {/* Card A: Sentence Pause Gap */}
            <div className="p-4 rounded-xl bg-[#141824] border border-white/[0.06] space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">Sentence Pause</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Silence between sentences</p>
                </div>
                <span className="font-mono text-xs font-bold px-2 py-1 rounded-md bg-[#FF5C29]/15 text-[#FF5C29]">
                  {settings.sentenceGap} ms
                </span>
              </div>

              <div className="relative flex items-center h-6">
                <div className="absolute left-0 right-0 h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-[#FF5C29] rounded-full"
                    style={{ width: `${(settings.sentenceGap / 600) * 100}%` }}
                  />
                </div>
                <input
                  type="range"
                  min="0"
                  max="600"
                  step="20"
                  value={settings.sentenceGap}
                  onChange={(e) => handleGapChange(parseInt(e.target.value, 10))}
                  aria-label="Sentence gap"
                  className="w-full absolute opacity-0 cursor-pointer h-6 z-10"
                />
              </div>

              <div className="flex justify-between text-[11px] font-mono text-slate-400">
                <span>0 ms (Instant)</span>
                <span>300 ms</span>
                <span>600 ms</span>
              </div>
            </div>

            {/* Card B: Pause on Punctuation */}
            <div className="p-4 rounded-xl bg-[#141824] border border-white/[0.06] flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-white">Pause on Punctuation</h3>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Adds subtle natural pauses at commas, colons, and semicolons instead of rushing clauses.
                </p>
              </div>
              <Switch
                checked={settings.pauseOnPunctuation}
                onChange={handlePauseToggle}
                label="Pause on punctuation"
              />
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* SECTION 4: KEYBOARD SHORTCUT RECORDER                           */}
        {/* ---------------------------------------------------------------- */}
        <section className="rounded-2xl bg-[#11141E] border border-white/[0.08] p-6 shadow-xl space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-white/[0.06]">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Keyboard size={18} className="text-[#FF5C29]" />
                Keyboard Shortcut
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Select any text and press this key chord to begin reading immediately.
              </p>
            </div>
            <a
              href="chrome://extensions/shortcuts"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#FF5C29] hover:underline flex items-center gap-1 self-start sm:self-auto font-medium"
            >
              <Command size={12} /> Chrome System Shortcuts
            </a>
          </div>

          <div className="p-5 rounded-xl bg-[#141824] border border-white/[0.06] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {parseShortcutKeys(shortcut).map((key, i) => (
                  <React.Fragment key={i}>
                    <kbd className="px-3 py-1.5 rounded-lg bg-[#0E121B] border border-white/15 text-white font-mono text-xs font-semibold shadow-sm">
                      {key}
                    </kbd>
                    {i < parseShortcutKeys(shortcut).length - 1 && (
                      <span className="text-slate-500 font-bold text-xs">+</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-2">
                Pressing while speech is playing toggles pause & resume.
              </p>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() =>
                  recording ? (setRecording(false), clearRecording()) : startRecording()
                }
                className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-all ${
                  recording
                    ? 'border-[#FF5C29] bg-[#FF5C29]/20 text-[#FF5C29] animate-pulse ring-2 ring-[#FF5C29]/40'
                    : 'border-white/10 bg-white/5 text-white hover:bg-white/10 hover:border-white/20'
                }`}
              >
                {recording ? 'Press your key combination…' : 'Record New Shortcut'}
              </button>

              {shortcut && !recording && (
                <button
                  type="button"
                  onClick={() => saveShortcut(isMac ? 'Command+Shift+S' : 'Ctrl+Shift+S')}
                  title="Reset to default (Ctrl+Shift+S)"
                  className="p-2 rounded-xl border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <RotateCcw size={14} />
                </button>
              )}
            </div>
          </div>

          {shortcutError && <p className="text-xs text-rose-400 font-medium">{shortcutError}</p>}
          {shortcutSaved && (
            <p className="text-xs text-emerald-400 font-medium flex items-center gap-1">
              <Check size={13} /> Shortcut updated successfully!
            </p>
          )}
        </section>

        {/* Footer */}
        <footer className="pt-6 pb-12 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500 border-t border-white/[0.06]">
          <p>Larynx v{VERSION} — Open Source MIT License</p>
          <p className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            100% Private · Zero analytics · No audio leaves your computer
          </p>
        </footer>
      </div>
    </div>
  );
};

export function mountOptionsApp(root: HTMLElement) {
  const r = createRoot(root);
  r.render(<OptionsApp />);
  return r;
}
