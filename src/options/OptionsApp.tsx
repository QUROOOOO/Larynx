// Options Page — Voice picker, speed slider, sentence gap, pause toggle, shortcut config

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Mic,
  MicOff,
  Volume2,
  Settings,
  ChevronUp,
  ChevronDown,
  Keyboard,
  Check,
  Play,
  Search,
} from 'lucide-react';
import { getSettings, setSettings, onSettingsChange, TTSSettings } from '../shared/storage';
import { VoiceInfo, DEFAULT_SETTINGS } from '../shared/types';

const ACCENT = '#00ff87';
const PREVIEW_TEXT = 'The quick brown fox jumps over the lazy dog.';
const COMMAND_NAME = 'speak-selection';
const RECORDING_TIMEOUT_MS = 5000;
const SHORTCUT_UPDATE_TIMEOUT_MS = 2500;

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
    className={`relative shrink-0 w-11 h-6 rounded-full border transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00ff87]/60 ${
      checked ? 'bg-[#00ff87]/85 border-[#00ff87]' : 'bg-white/10 border-white/15'
    }`}
  >
    <span
      className={`absolute top-1/2 -translate-y-1/2 w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-all duration-200 ${
        checked ? 'left-[22px]' : 'left-[3px]'
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
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm bg-white/[0.03] border border-white/10 rounded-lg text-gray-200 hover:border-white/20 focus:outline-none focus-visible:border-[#00ff87]/50 transition-colors"
      >
        <span className="truncate">{selected?.label ?? label}</span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={`shrink-0 text-gray-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="absolute z-30 mt-1.5 w-full max-h-64 overflow-y-auto rounded-lg border border-white/12 bg-[#141414] p-1 shadow-2xl shadow-black/60"
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
                className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-left text-sm rounded-md transition-colors ${
                  isSelected ? 'bg-[#00ff87]/12 text-[#00ff87]' : 'text-gray-300 hover:bg-white/5'
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <Check size={14} strokeWidth={2.5} className="shrink-0" />}
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
    const loadVoices = () => {
      if (!window.speechSynthesis) {
        setLoadingVoices(false);
        return;
      }
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
      u.onend = () => setPreviewingURI(cur => (cur === voiceURI ? null : cur));
      u.onerror = () => setPreviewingURI(cur => (cur === voiceURI ? null : cur));
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

  const renderVoiceRow = (voice: VoiceInfo) => {
    const isSelected = selectedVoiceURI === voice.voiceURI;
    const isPlaying = previewingURI === voice.voiceURI;
    return (
      <div
        key={voice.voiceURI}
        className={`flex items-center gap-2 pl-4 pr-2 py-2.5 rounded-xl border transition-all ${
          isSelected
            ? 'border-[#00ff87]/50 bg-[#00ff87]/10'
            : 'border-white/10 bg-white/[0.02] hover:border-white/20'
        }`}
      >
        <button
          type="button"
          onClick={() => handleVoiceChange(voice.voiceURI)}
          className="flex-1 min-w-0 flex items-center gap-3 text-left focus:outline-none"
        >
          <div
            className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center ${
              voice.isNatural ? 'bg-[#00ff87]/15 text-[#00ff87]' : 'bg-white/5 text-gray-500'
            }`}
          >
            <Mic size={16} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">{voice.name}</p>
            <p className="text-xs text-gray-500 font-mono truncate">{voice.lang}</p>
          </div>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          {voice.isNatural && (
            <span className="px-2 py-0.5 text-[10px] font-mono font-medium text-[#00ff87] bg-[#00ff87]/10 rounded">
              BEST
            </span>
          )}
          {voice.localService && (
            <span className="px-2 py-0.5 text-[10px] font-mono text-gray-500 bg-white/5 rounded">
              LOCAL
            </span>
          )}
          <button
            type="button"
            onClick={() => previewVoice(voice.voiceURI)}
            aria-label={`${isPlaying ? 'Stop' : 'Preview'} ${voice.name}`}
            className={`w-8 h-8 rounded-full flex items-center justify-center border transition-colors ${
              isPlaying
                ? 'border-[#00ff87] bg-[#00ff87]/20 text-[#00ff87]'
                : 'border-white/10 text-gray-400 hover:border-[#00ff87]/50 hover:text-[#00ff87]'
            }`}
          >
            <Play size={13} strokeWidth={2.5} className={isPlaying ? 'animate-pulse' : ''} />
          </button>
          {isSelected && <Check size={16} strokeWidth={2.5} color={ACCENT} />}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100 font-sans">
      <header className="border border-white/10 bg-[#111]/80 backdrop-blur-md">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-[#00ff87]/10 flex items-center justify-center">
              <Volume2 size={22} strokeWidth={2} color={ACCENT} />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">Larynx</h1>
              <p className="text-sm text-gray-500 mt-0.5">Select text anywhere, hear it spoken naturally</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8 space-y-10">
        {/* Voice */}
        <section>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-1">
            <Mic size={18} strokeWidth={2} color={ACCENT} />
            Voice
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Pick a voice and press play to hear a sample. Only the highest quality voices are shown first.
          </p>

          {loadingVoices ? (
            <div className="flex items-center gap-2 text-gray-500 text-sm">
              <div className="w-4 h-4 border-2 border-[#00ff87] border-t-transparent rounded-full animate-spin" />
              Loading voices...
            </div>
          ) : totalVoices === 0 ? (
            <div className="text-center py-8 text-gray-500 text-sm border border-white/10 rounded-xl">
              <MicOff size={28} strokeWidth={1.5} className="mx-auto mb-2 opacity-40" />
              <p>No voices available. Voices load from the system Speech Synthesis API.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row gap-2 mb-3">
                <div className="relative flex-1">
                  <Search
                    size={14}
                    strokeWidth={2}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
                  />
                  <input
                    type="search"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search voices"
                    className="w-full pl-9 pr-3 py-2 text-sm bg-white/[0.03] border border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-[#00ff87]/50"
                  />
                </div>
                <Dropdown
                  value={langFilter}
                  options={languageOptions}
                  onChange={setLangFilter}
                  label="Filter by language"
                  className="sm:w-48 w-full"
                />
                <button
                  type="button"
                  onClick={() => setOnlyNatural(v => !v)}
                  aria-pressed={onlyNatural}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    onlyNatural
                      ? 'border-[#00ff87]/50 bg-[#00ff87]/10 text-[#00ff87]'
                      : 'border-white/10 bg-white/[0.03] text-gray-400 hover:border-white/20'
                  }`}
                >
                  Best only
                </button>
              </div>

              <p className="text-xs text-gray-600 mb-3 font-mono">
                Showing {shownVoices} of {totalVoices} voices
              </p>

              {shownVoices === 0 ? (
                <div className="text-center py-6 text-gray-500 text-sm border border-white/10 rounded-xl">
                  No voices match that filter.
                </div>
              ) : (
                <div className="space-y-4 max-h-[34rem] overflow-y-auto pr-1">
                  {pinnedSelected && (
                    <div>
                      <p className="text-[11px] font-mono uppercase tracking-wider text-[#00ff87]/70 sticky top-0 bg-[#0a0a0a]/95 py-1.5 backdrop-blur-sm">
                        In use
                      </p>
                      <div className="space-y-2 mt-1">{renderVoiceRow(pinnedSelected)}</div>
                    </div>
                  )}

                  {grouped.map(([lang, list]) => (
                    <div key={lang}>
                      <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500 sticky top-0 bg-[#0a0a0a]/95 py-1.5 backdrop-blur-sm">
                        {LANG_LABELS[lang] ?? lang} · {list.length}
                      </p>
                      <div className="space-y-2 mt-1">{list.map(renderVoiceRow)}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        {/* Speed */}
        <section>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-1">Speed</h2>
          <p className="text-sm text-gray-500 mb-4">Adjust speech rate. Uses the Web Speech API rate parameter.</p>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Slow</span>
              <span className="font-mono text-white">{settings.rate.toFixed(2)}x</span>
              <span className="text-gray-500">Fast</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.05"
              value={settings.rate}
              onChange={e => handleRateChange(parseFloat(e.target.value))}
              className="w-full h-1.5 appearance-none rounded-full bg-white/10
                [&::-webkit-slider-thumb]:appearance-none
                [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#00ff87]
                [&::-webkit-slider-thumb]:cursor-pointer
                cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-600 font-mono">
              <span>0.5x</span>
              <span>1.0x</span>
              <span>2.0x</span>
            </div>
          </div>
        </section>

        {/* Sentence Gap */}
        <section>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-1">
            <ChevronUp size={18} strokeWidth={2} color={ACCENT} />
            <ChevronDown size={18} strokeWidth={2} color={ACCENT} />
            Pause Between Sentences
          </h2>
          <p className="text-sm text-gray-500 mb-4">Add a natural pause after each sentence for better comprehension.</p>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">None</span>
              <span className="font-mono text-white">{settings.sentenceGap}ms</span>
              <span className="text-gray-500">Long</span>
            </div>
            <input
              type="range"
              min="0"
              max="1000"
              step="50"
              value={settings.sentenceGap}
              onChange={e => handleGapChange(parseInt(e.target.value))}
              className="w-full h-1.5 appearance-none rounded-full bg-white/10
                [&::-webkit-slider-thumb]:appearance-none
                [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#00ff87]
                [&::-webkit-slider-thumb]:cursor-pointer
                cursor-pointer"
            />
          </div>
        </section>

        {/* Pause on punctuation toggle */}
        <section>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Settings size={18} strokeWidth={2} />
                Pause on Punctuation
              </h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Insert natural pauses at sentence boundaries.{' '}
                <span className="text-gray-400">{settings.pauseOnPunctuation ? 'On' : 'Off'}</span>
              </p>
            </div>
            <Switch
              checked={settings.pauseOnPunctuation}
              onChange={handlePauseToggle}
              label="Pause on punctuation"
            />
          </div>
        </section>

        {/* Shortcut */}
        <section className="border border-white/10 pt-8">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
            <Keyboard size={18} strokeWidth={2} />
            Keyboard Shortcut
          </h2>
          <div className="bg-white/[0.03] border border-white/10 rounded-xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-white">Speak Selection</p>
                <p className="text-sm text-gray-500 mt-0.5">
                  Press to record. While speaking, the same key pauses and resumes.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => (recording ? (setRecording(false), clearRecording()) : startRecording())}
                  className={`px-3 py-2 rounded-lg text-xs font-mono border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00ff87]/60 ${
                    recording
                      ? 'border-[#00ff87] bg-[#00ff87]/15 text-[#00ff87] animate-pulse'
                      : 'border-white/10 bg-white/5 text-gray-200 hover:border-white/25'
                  }`}
                >
                  {recording ? 'Press keys…' : prettyShortcut(shortcut)}
                </button>
                {shortcut && !recording && (
                  <button
                    type="button"
                    onClick={() => saveShortcut(isMac ? 'Command+Shift+S' : 'Ctrl+Shift+S')}
                    className="text-xs text-gray-500 hover:text-[#00ff87] transition-colors"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {shortcutError && <p className="text-xs text-red-400">{shortcutError}</p>}
            {shortcutSaved && <p className="text-xs text-[#00ff87]">Shortcut updated.</p>}

            <p className="text-xs text-gray-600">
              Chrome reserves some combinations. You can also change it in{' '}
              <a
                href="chrome://extensions/shortcuts"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#00ff87] hover:underline"
              >
                Chrome shortcut settings
              </a>
              .
            </p>
          </div>
        </section>

        <footer className="border-t border-white/5 pt-6 text-center">
          <p className="text-sm text-gray-600">Larynx v1.0.6 — Built with Web Speech API</p>
        </footer>
      </main>
    </div>
  );
};

export function mountOptionsApp(root: HTMLElement) {
  const r = createRoot(root);
  r.render(<OptionsApp />);
  return r;
}
