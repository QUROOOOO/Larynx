// Options Page — Voice picker, speed slider, sentence gap, pause toggle, shortcut config

import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Mic, MicOff, Volume2, Settings, ChevronUp, ChevronDown, Keyboard, Check } from 'lucide-react';
import { getSettings, setSettings, onSettingsChange, TTSSettings } from '../shared/storage';
import { VoiceInfo, DEFAULT_SETTINGS } from '../shared/types';

const ACCENT = '#00ff87';

export const OptionsApp: React.FC = () => {
  const [settings, setSettingsState] = useState<TTSSettings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState('');

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
      if (!window.speechSynthesis) return;
      const allVoices = window.speechSynthesis.getVoices();
      const naturalKeywords = ['neural', 'enhanced', 'premium', 'google', 'microsoft', 'apple', 'wave'];
      const parsed: VoiceInfo[] = allVoices.map(v => ({
        name: v.name,
        lang: v.lang,
        voiceURI: v.voiceURI,
        localService: v.localService,
        isNatural: naturalKeywords.some(k => v.name.toLowerCase().includes(k) || v.voiceURI.toLowerCase().includes(k)),
      }));
      // Sort: natural voices first, then by name
      parsed.sort((a, b) => {
        if (a.isNatural !== b.isNatural) return b.isNatural ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      setVoices(parsed);
      setLoadingVoices(false);
    };
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, []);

  const handleSettingChange = useCallback(async (partial: Partial<TTSSettings>) => {
    const next = { ...settings, ...partial };
    setSettingsState(next);
    await setSettings(partial);
  }, [settings]);

  const handleVoiceChange = useCallback(async (voiceURI: string) => {
    setSelectedVoiceURI(voiceURI);
    await handleSettingChange({ voice: voiceURI });
  }, [handleSettingChange]);

  const handleRateChange = useCallback(async (rate: number) => {
    await handleSettingChange({ rate });
  }, [handleSettingChange]);

  const handleGapChange = useCallback(async (gap: number) => {
    await handleSettingChange({ sentenceGap: gap });
  }, [handleSettingChange]);

  const handlePauseToggle = useCallback(async (checked: boolean) => {
    await handleSettingChange({ pauseOnPunctuation: checked });
  }, [handleSettingChange]);

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
          <p className="text-sm text-gray-500 mb-4">Choose the system voice for text-to-speech. Voices marked NATURAL use neural synthesis.</p>

          {loadingVoices ? (
            <div className="flex items-center gap-2 text-gray-500 text-sm">
              <div className="w-4 h-4 border-2 border-[#00ff87] border-t-transparent rounded-full animate-spin" />
              Loading voices...
            </div>
          ) : voices.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-sm border border-white/10 rounded-xl">
              <MicOff size={28} strokeWidth={1.5} className="mx-auto mb-2 opacity-40" />
              <p>No voices available. Voices load from the system Speech Synthesis API.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[36rem] overflow-y-auto pr-1">
              {voices.map(voice => (
                <button
                  key={voice.voiceURI}
                  onClick={() => handleVoiceChange(voice.voiceURI)}
                  className={`w-full px-4 py-3 text-left rounded-xl border transition-all ${
                    selectedVoiceURI === voice.voiceURI
                      ? 'border-[#00ff87]/50 bg-[#00ff87]/10'
                      : 'border-white/10 bg-white/[0.02] hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
                        voice.isNatural
                          ? 'bg-[#00ff87]/15 text-[#00ff87]'
                          : 'bg-white/5 text-gray-500'
                      }`}>
                        <Mic size={16} strokeWidth={2} />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-white">{voice.name}</p>
                        <p className="text-xs text-gray-500 font-mono">{voice.lang}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {voice.isNatural && (
                        <span className="px-2 py-0.5 text-[10px] font-mono font-medium text-[#00ff87] bg-[#00ff87]/10 rounded">NATURAL</span>
                      )}
                      {voice.localService && (
                        <span className="px-2 py-0.5 text-[10px] font-mono text-gray-500 bg-white/5 rounded">LOCAL</span>
                      )}
                      {selectedVoiceURI === voice.voiceURI && <Check size={16} strokeWidth={2.5} color={ACCENT} />}
                    </div>
                  </div>
                </button>
              ))}
            </div>
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
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Settings size={18} strokeWidth={2} />
                Pause on Punctuation
              </h2>
              <p className="text-sm text-gray-500 mt-0.5">Insert natural pauses at sentence boundaries.</p>
            </div>
            <button
              onClick={() => handlePauseToggle(!settings.pauseOnPunctuation)}
              role="switch"
              aria-checked={settings.pauseOnPunctuation}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                settings.pauseOnPunctuation ? 'bg-[#00ff87]' : 'bg-white/15'
              }`}
            >
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                settings.pauseOnPunctuation ? 'translate-x-5' : 'translate-x-0.5'
              }`} />
            </button>
          </div>
        </section>

        {/* Shortcut */}
        <section className="border border-white/10 pt-8">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
            <Keyboard size={18} strokeWidth={2} />
            Keyboard Shortcut
          </h2>
          <div className="bg-white/[0.03] border border-white/10 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">Speak Selection</p>
                <p className="text-sm text-gray-500 mt-0.5">Default shortcut</p>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="px-2 py-1 bg-white/10 rounded text-xs font-mono text-gray-300">Ctrl+Shift+S</kbd>
                <span className="text-gray-600 text-xs">/</span>
                <kbd className="px-2 py-1 bg-white/10 rounded text-xs font-mono text-gray-300">⌘+Shift+S</kbd>
              </div>
            </div>
            <p className="text-xs text-gray-600 mt-3">
              Change in{' '}
              <a href="chrome://extensions/shortcuts" target="_blank" rel="noopener noreferrer" className="text-[#00ff87] hover:underline">
                Chrome shortcut settings
              </a>
              .
            </p>
          </div>
        </section>

        <footer className="border-t border-white/5 pt-6 text-center">
          <p className="text-sm text-gray-600">Larynx v1.0.4 — Built with Web Speech API</p>
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
