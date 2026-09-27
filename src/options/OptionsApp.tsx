// Options Page — Voice picker, speed slider, pause on punctuation, shortcut link

import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Mic, MicOff, ChevronDown, ChevronUp, 
  ExternalLink, Settings, Volume2,
  Check, X
} from 'lucide-react';
import { getSettings, setSettings, onSettingsChange, TTSSettings } from '../shared/storage';
import { DEFAULT_SETTINGS } from '../shared/types';
import { VoiceInfo } from '../shared/types';

const ACCENT_COLOR = '#00FF87';

interface VoiceOptionProps {
  voice: VoiceInfo;
  isSelected: boolean;
  onSelect: () => void;
}

const VoiceOption: React.FC<VoiceOptionProps> = ({ voice, isSelected, onSelect }) => (
  <button
    onClick={onSelect}
    className={`w-full px-4 py-3 text-left rounded-lg border transition-all ${
      isSelected
        ? `border-[${ACCENT_COLOR}] bg-[${ACCENT_COLOR}]/10 text-gray-900 dark:text-gray-100`
        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 bg-white dark:bg-gray-800'
    }`}
  >
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
          voice.isNatural 
            ? `bg-[${ACCENT_COLOR}]/20 text-[${ACCENT_COLOR}]` 
            : 'bg-gray-100 dark:bg-gray-700 text-gray-500'
        }`}>
          <Mic size={18} strokeWidth={2} />
        </div>
        <div>
          <p className="font-medium text-sm">{voice.name}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">{voice.lang}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {voice.isNatural && (
          <span className="px-2 py-0.5 text-[10px] font-mono font-medium bg-[${ACCENT_COLOR}]/20 text-[${ACCENT_COLOR}] rounded">
            NATURAL
          </span>
        )}
        {voice.localService && (
          <span className="px-2 py-0.5 text-[10px] font-mono font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded">
            LOCAL
          </span>
        )}
        {isSelected && <Check size={16} strokeWidth={3} className={`text-[${ACCENT_COLOR}]`} />}
      </div>
    </div>
  </button>
);

const SpeedSlider: React.FC<{ 
  value: number; 
  onChange: (v: number) => void; 
  disabled?: boolean 
}> = ({ value, onChange, disabled }) => (
  <div className="space-y-2">
    <div className="flex justify-between text-sm">
      <span className="text-gray-500 dark:text-gray-400">Slow</span>
      <span className="font-mono font-medium text-gray-900 dark:text-gray-100">{value.toFixed(2)}x</span>
      <span className="text-gray-500 dark:text-gray-400">Fast</span>
    </div>
    <input
      type="range"
      min="0.5"
      max="2"
      step="0.05"
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      disabled={disabled}
      className={`w-full h-2 appearance-none rounded-lg bg-gray-200 dark:bg-gray-700 
        [&::-webkit-slider-thumb]:appearance-none 
        [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 
        [&::-webkit-slider-thumb]:rounded-full 
        [&::-webkit-slider-thumb]:bg-[${ACCENT_COLOR}] 
        [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white
        [&::-webkit-slider-thumb]:shadow-lg
        focus:outline-none focus:ring-2 focus:ring-[${ACCENT_COLOR}]/50
        disabled:opacity-50 disabled:cursor-not-allowed`}
    />
    <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 font-mono">
      <span>0.5x</span>
      <span>1.0x</span>
      <span>2.0x</span>
    </div>
  </div>
);

export const OptionsApp: React.FC = () => {
  const [settings, setSettingsState] = useState<TTSSettings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(true);

  useEffect(() => {
    getSettings().then(setSettingsState);
    
    const unsubscribe = onSettingsChange(setSettingsState);
    return unsubscribe;
  }, []);

  useEffect(() => {
    setLoadingVoices(false);
  }, []);

  const handleSettingChange = async (partial: Partial<TTSSettings>) => {
    const newSettings = { ...settings, ...partial };
    setSettingsState(newSettings);
    await setSettings(partial);
  };

  const handleVoiceChange = async (voiceURI: string) => {
    await handleSettingChange({ voice: voiceURI });
  };

  const handleRateChange = async (rate: number) => {
    await handleSettingChange({ rate });
  };

  const handlePauseOnPunctuationChange = async (checked: boolean) => {
    await handleSettingChange({ pauseOnPunctuation: checked });
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans">
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center bg-[${ACCENT_COLOR}]`}>
              <Volume2 size={24} strokeWidth={2} className="text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Larynx</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Select any text on the web, hear it in a natural voice — instantly.
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Mic size={20} strokeWidth={2} />
              Voice
            </h2>
            {loadingVoices && (
              <div className="w-5 h-5 border-2 border-[${ACCENT_COLOR}] border-t-transparent rounded-full animate-spin" />
            )}
          </div>
          
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Choose the system voice for text-to-speech. Voices marked <span className="font-medium text-[${ACCENT_COLOR}]">NATURAL</span> 
            use neural/enhanced synthesis for more human-like quality.
          </p>

          <div className="space-y-2 max-h-96 overflow-y-auto">
            {voices.length > 0 ? (
              voices.map(voice => (
                <VoiceOption
                  key={voice.voiceURI}
                  voice={voice}
                  isSelected={voice.voiceURI === settings.voice}
                  onSelect={() => handleVoiceChange(voice.voiceURI)}
                />
              ))
            ) : (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <MicOff size={32} strokeWidth={1.5} className="mx-auto mb-2 opacity-50" />
                <p>No voices available. Voices load from system Speech Synthesis API.</p>
                <p className="text-xs mt-1">Try opening a page with text and using the shortcut first.</p>
              </div>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
            <ChevronUp size={20} strokeWidth={2} className="text-[${ACCENT_COLOR}]" />
            <ChevronDown size={20} strokeWidth={2} className="text-[${ACCENT_COLOR}]" />
            Speed
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Adjust speech rate. Uses Web Speech API's native <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">rate</code> 
            parameter — re-synthesizes timing at engine level, no pitch distortion.
          </p>
          <SpeedSlider 
            value={settings.rate} 
            onChange={handleRateChange} 
          />
        </section>

        <section>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Settings size={20} strokeWidth={2} />
                Pause on Punctuation
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Insert natural pauses between sentences for better comprehension.
              </p>
            </div>
            <button
              onClick={() => handlePauseOnPunctuationChange(!settings.pauseOnPunctuation)}
              className={`relative w-12 h-7 rounded-full transition-all flex items-center ${
                settings.pauseOnPunctuation
                  ? `bg-[${ACCENT_COLOR}]`
                  : 'bg-gray-200 dark:bg-gray-700'
              }`}
              role="switch"
              aria-checked={settings.pauseOnPunctuation}
            >
              <span className={`absolute w-5 h-5 bg-white rounded-full shadow transition-transform ${
                settings.pauseOnPunctuation ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </section>

        <section className="border-t border-gray-200 dark:border-gray-800 pt-8">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
            <ExternalLink size={20} strokeWidth={2} />
            Keyboard Shortcut
          </h2>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="font-medium">Speak Selection</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Default: <kbd className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded font-mono text-xs">Ctrl+Shift+S</kbd>
                  <span className="hidden mac:block"> / </span>
                  <kbd className="hidden mac:inline-flex px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded font-mono text-xs">⌘+Shift+S</kbd>
                </p>
              </div>
              <a
                href="chrome://extensions/shortcuts"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-[${ACCENT_COLOR}] dark:hover:text-[${ACCENT_COLOR}] transition-colors"
              >
                Remap Shortcut
                <ExternalLink size={14} strokeWidth={2} />
              </a>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Opens Chrome's keyboard shortcut settings for extensions. Changes take effect immediately.
            </p>
          </div>
        </section>

        <footer className="border-t border-gray-200 dark:border-gray-800 pt-6 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Larynx v0.1.0 — MIT License
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Built with Web Speech API — Zero dependencies, zero cost.
          </p>
        </footer>
      </main>
    </div>
  );
};

export function mountOptionsApp(root: HTMLElement) {
  const reactRoot = createRoot(root);
  reactRoot.render(<OptionsApp />);
  return reactRoot;
}
