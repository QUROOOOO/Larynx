// chrome.storage.sync wrapper with type safety

import { TTSSettings, DEFAULT_SETTINGS, StoredSettings } from './types';

const SETTINGS_KEY = 'larynx_settings';

export async function getSettings(): Promise<TTSSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(SETTINGS_KEY, (result) => {
      const stored = result[SETTINGS_KEY] as StoredSettings | undefined;
      if (!stored) {
        resolve(DEFAULT_SETTINGS);
        return;
      }
      resolve({
        voice: stored.voice ?? DEFAULT_SETTINGS.voice,
        rate: stored.rate ?? DEFAULT_SETTINGS.rate,
        pauseOnPunctuation: stored.pauseOnPunctuation ?? DEFAULT_SETTINGS.pauseOnPunctuation,
      });
    });
  });
}

export async function setSettings(partial: Partial<TTSSettings>): Promise<void> {
  const current = await getSettings();
  const merged: StoredSettings = { ...current, ...partial };
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [SETTINGS_KEY]: merged }, () => resolve());
  });
}

export function onSettingsChange(callback: (settings: TTSSettings) => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
    if (changes[SETTINGS_KEY]) {
      const newValue = changes[SETTINGS_KEY].newValue as StoredSettings | undefined;
      if (newValue) {
        callback({
          voice: newValue.voice ?? DEFAULT_SETTINGS.voice,
          rate: newValue.rate ?? DEFAULT_SETTINGS.rate,
          pauseOnPunctuation: newValue.pauseOnPunctuation ?? DEFAULT_SETTINGS.pauseOnPunctuation,
        });
      }
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
