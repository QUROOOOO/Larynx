// Floating Pill UI Component — Nothing-OS-style aesthetic
// Monochrome, sharp, dot-matrix accents, accent color only on active/playing state

import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, FastForward, 
  Mic, X, 
  ChevronUp, ChevronDown 
} from 'lucide-react';

interface PillUIProps {
  initialRect: DOMRect;
  onAction: (action: string) => void;
  currentSentence?: string;
  sentenceIndex?: number;
  voices?: { name: string; voiceURI: string; isNatural: boolean }[];
  currentVoiceURI?: string;
  rate?: number;
  isPlaying?: boolean;
}

export const PillUI: React.FC<PillUIProps> = ({
  initialRect,
  onAction,
  currentSentence,
  sentenceIndex,
  voices = [],
  currentVoiceURI = '',
  rate = 1.0,
  isPlaying = false,
}) => {
  const [showSpeed, setShowSpeed] = useState(false);
  const [showVoices, setShowVoices] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    if (pillRef.current && initialRect) {
      const x = initialRect.left + initialRect.width / 2;
      const y = initialRect.bottom + 8;
      pillRef.current.style.left = `${x}px`;
      pillRef.current.style.top = `${y}px`;
    }
  }, [initialRect]);

  useEffect(() => {
    if (!mounted) return;
    const el = pillRef.current;
    if (el) {
      el.style.opacity = '0';
      el.style.transform = 'scale(0.9) translateY(4px)';
      requestAnimationFrame(() => {
        el.style.transition = 'opacity 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
        el.style.opacity = '1';
        el.style.transform = 'scale(1) translateY(0)';
      });
    }
  }, [mounted]);

  const handleAction = (action: string) => {
    onAction(action);
    setShowSpeed(false);
    setShowVoices(false);
  };

  return (
    <div
      ref={pillRef}
      className="fixed z-[2147483647] pointer-events-auto animate-spring-in"
      style={{
        left: initialRect.left + initialRect.width / 2,
        top: initialRect.bottom + 8,
        transform: 'translateX(-50%)',
      }}
      role="dialog"
      aria-label="Larynx TTS controls"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm border border-gray-200 dark:border-gray-700 rounded-full shadow-xl">
        <button
          onClick={() => handleAction('play_pause')}
          className={`p-2 rounded-full transition-colors ${
            isPlaying 
              ? 'bg-accent text-white hover:bg-accent/90' 
              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={18} strokeWidth={2.5} /> : <Play size={18} strokeWidth={2.5} />}
        </button>

        <div className="relative">
          <button
            onClick={() => setShowSpeed(!showSpeed)}
            className="p-2 rounded-full text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="Speed"
            aria-expanded={showSpeed}
          >
            <FastForward size={16} strokeWidth={2} />
          </button>
          {showSpeed && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex items-center gap-2 px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg animate-spring-in">
              <button
                onClick={() => handleAction('speed_down')}
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                aria-label="Slower"
              >
                <ChevronDown size={14} strokeWidth={2.5} />
              </button>
              <span className="font-mono text-xs text-gray-700 dark:text-gray-300 w-10 text-center">
                {rate.toFixed(2)}x
              </span>
              <button
                onClick={() => handleAction('speed_up')}
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                aria-label="Faster"
              >
                <ChevronUp size={14} strokeWidth={2.5} />
              </button>
            </div>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setShowVoices(!showVoices)}
            className="p-2 rounded-full text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="Voice"
            aria-expanded={showVoices}
          >
            <Mic size={16} strokeWidth={2} />
          </button>
          {showVoices && voices.length > 0 && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg animate-spring-in max-h-60 overflow-y-auto">
              {voices.map((voice) => (
                <button
                  key={voice.voiceURI}
                  onClick={() => {
                    onAction('next_voice');
                    setShowVoices(false);
                  }}
                  className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                    voice.voiceURI === currentVoiceURI
                      ? 'bg-accentDim text-accent font-medium'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span>{voice.name}</span>
                    {voice.isNatural && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-accentDim text-accent rounded font-mono">
                        NATURAL
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {currentSentence && (
          <div className="flex-1 min-w-0 px-2">
            <p className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">
              {sentenceIndex !== undefined ? `${sentenceIndex + 1}. ` : ''}{currentSentence}
            </p>
          </div>
        )}

        <button
          onClick={() => handleAction('dismiss')}
          className="p-2 rounded-full text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          aria-label="Dismiss"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="absolute bottom-[-4px] left-1/2 -translate-x-1/2 w-16 h-0.5 bg-gradient-to-r from-transparent via-accent to-transparent rounded-full opacity-60" />
    </div>
  );
};
