# Larynx

> Select any text on the web, hear it in a natural voice — instantly.

A lightweight, privacy-first Chrome extension for text-to-speech. Zero dependencies, zero cost — uses the browser's built-in Web Speech API.

## Features

- **Instant TTS**: Select text → press `Ctrl+Shift+S` (or `Cmd+Shift+S`) → hear it immediately
- **Negative-Blend Word Highlighting**: In-place dynamic word inversion (`mix-blend-mode: difference`) tracking speech in real-time on any webpage theme without reflow or layout shifts
- **Lossless DOM Restoration**: Injected word spans preserve the host page byte-for-byte; cleanly unwrapped when speech completes
- **Smart Speech Normalization**: Excludes noisy markup, bare URLs, emails, citations `[1]`, and structural arrows while accurately mapping spoken syllables back to the original source text
- **Multi-Frame & Iframe Support**: Automatically detects selections inside iframes and routes playback highlights directly to the matching frame
- **Zero-Friction Shortcut Toggle**: Shortcut triggers speech when text is selected, or toggles pause/resume while speaking
- **Sentence-Aware Breathing**: Natural, configurable pauses between sentences for maximum comprehension
- **Editorial Options Specimen**: Type-specimen sheet options UI with live boundary cadence visualization, voice quality scoring ("Best"), pace/WPM estimator, and shortcut recorder
- **Settings Sync**: Preferences synced across devices via `chrome.storage.sync`
- **Zero Idle Overhead**: Event-driven Manifest V3 service worker and on-demand offscreen document that closes after 30 seconds idle

## Install (Development)

```bash
# Clone and install
git clone https://github.com/QUROOOOO/Larynx.git
cd Larynx
npm install

# Build extension
npm run build

# Load in Chrome
1. Open chrome://extensions/
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/` folder
```

## Usage

1. Select any text on any webpage.
2. Press `Ctrl+Shift+S` (`Cmd+Shift+S` on macOS).
3. The selected passage begins playing aloud, highlighting word-by-word with high-contrast inverted styling.
4. Press the shortcut again while playing to **pause / resume**.
5. Customize voice, pace, punctuation pauses, or keyboard shortcuts anytime via extension **Options**.

## Architecture

```
┌─────────────────────────────────┐     ┌──────────────────────────────────┐     ┌─────────────────────────────────┐
│     Background Service Worker   │────▶│       Offscreen Document         │────▶│       Web Speech API            │
│  (Event-driven, frame router)   │     │ (Speech queue, clock, boundary)  │     │   (window.speechSynthesis)      │
└────────────────┬────────────────┘     └────────────────┬─────────────────┘     └─────────────────────────────────┘
                 │                                       │
                 ▼                                       │ (Run-stamped progress)
┌─────────────────────────────────┐                      │
│        Content Script           │◀─────────────────────┘
│ (Injected on-demand per frame)  │
│ - Negative-blend word highlight │
│ - Speech-to-source mapping      │
│ - Lossless DOM unwrapping       │
└─────────────────────────────────┘
```

- **Background Service Worker**: Event-driven only — wakes on `chrome.commands` and messages, probes active frame selections, coordinates run IDs to discard stale messages, and manages offscreen document lifecycle.
- **Offscreen Document**: Created on-demand for audio synthesis, runs speech utterances sentence-by-sentence with monotonic clock drift compensation, and auto-closes after 30s idle.
- **Content Script**: Programmatically injected into active frames, wraps words losslessly into spans, executes negative-blend highlighting, and restores the DOM cleanly upon completion.
- **Options Sheet**: Editorial dark UI specimen built with React and Tailwind CSS v4, supporting live voice cadence profiling, language filtering, and browser shortcut binding.

## Performance Budget

| Metric | Target |
|--------|--------|
| JS Bundle (base) | < 150 KB |
| Service worker | Event-driven, no persistent loops |
| Content script | Injected on-demand only |
| Offscreen doc | Auto-closes after 30s idle |
| DOM safety | Full byte-for-byte unwrap via `parent.normalize()` |

## Tech Stack

- **Vite 5** + **React 18** + **TypeScript**
- **Tailwind CSS v4** (Editorial dark aesthetic)
- **Lucide React** icons
- **Manifest V3**

## Project Structure

```
src/
├── background/     # Event-driven service worker & frame routing
├── content/        # Injected content script & negative-blend word highlighter
├── offscreen/      # Offscreen document & SpeechSynthesis engine
├── options/        # Options specimen page (React + Tailwind v4)
├── shared/         # Messaging, storage sync, text normalization & types
└── styles/         # Global styling & Tailwind v4 theme tokens
```

## Development

```bash
# Watch mode (rebuilds on change)
npm run dev

# Production build
npm run build

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Roadmap

- [x] Instant text-to-speech with shortcut controls
- [x] In-place negative-blend word-level highlighting
- [x] Normalization & speech-to-source bidirectional mapping
- [x] Iframe and multi-frame selection awareness
- [ ] Milestone 2: Local neural voices (Piper / Kokoro WASM)
- [ ] Milestone 3: Cloud TTS integration (ElevenLabs, OpenAI, Azure)

## License

MIT
