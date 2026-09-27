# Larynx

> Select any text on the web, hear it in a natural voice — instantly.

A lightweight, privacy-first Chrome extension for text-to-speech. Zero dependencies, zero cost — uses the browser's built-in Web Speech API.

## Features

- **Instant TTS**: Select text → press `Ctrl+Shift+S` → hear it immediately
- **Floating pill UI**: Play/pause, speed control, voice cycling, dismiss
- **Sentence-aware pausing**: Natural pauses between sentences for better comprehension
- **Speed without pitch distortion**: Uses Web Speech API's native `rate` parameter
- **System voices**: Access all installed voices, with "Natural" tagging for neural/enhanced voices
- **Settings sync**: Preferences sync across devices via `chrome.storage.sync`
- **Remappable shortcut**: Change via `chrome://extensions/shortcuts`
- **Tiny footprint**: ~150KB JS bundle, no background memory when idle

## Install (Development)

```bash
# Clone and install
git clone https://github.com/QUROOOOO/Larynx.git
cd Larynx
pnpm install

# Build extension
pnpm build

# Load in Chrome
1. Open chrome://extensions/
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/` folder
```

## Usage

1. Select any text on any webpage
2. Press `Ctrl+Shift+S` (or your remapped shortcut)
3. Floating pill appears near selection — speech starts automatically
4. Use pill controls:
   - **Play/Pause**: Toggle playback
   - **Speed**: ±0.25x per click (0.5x – 2.0x)
   - **Voice**: Cycle through available system voices
   - **X**: Dismiss and stop

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Background SW  │────▶│  Offscreen Doc   │────▶│  Web Speech API │
│  (Event-driven) │     │  (On-demand)     │     │  (SpeechSynth)  │
└────────┬────────┘     └────────┬─────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌──────────────────┐
│ Content Script  │     │   Pill UI        │
│ (Injected on    │◀───▶│  (React +        │
│  shortcut)      │     │  Lucide icons)   │
└─────────────────┘     └──────────────────┘
```

- **Background Service Worker**: Event-driven only — wakes on `chrome.commands` and messages
- **Content Script**: Injected programmatically via `activeTab` + `chrome.scripting` on shortcut press
- **Offscreen Document**: Created on-demand for TTS, auto-closes after 30s idle
- **Pill UI**: React component mounted in page context, communicates via message passing

## Performance Budget

| Metric | Target |
|--------|--------|
| JS Bundle (base) | < 150 KB |
| Service worker | Event-driven, no persistent loops |
| Content script | Injected on-demand only |
| Offscreen doc | Auto-closes after 30s idle |
| No polling | No `selectionchange` listeners |

## Tech Stack

- **Vite** + **React 18** + **TypeScript**
- **Tailwind CSS v4** (Nothing-OS aesthetic)
- **Lucide React** icons
- **Manifest V3**
- **pnpm** package manager

## Project Structure

```
src/
├── background/     # Service worker (event-driven)
├── content/        # Content script (injected on-demand)
├── offscreen/      # Offscreen document (Web Speech API)
├── pill/           # Floating pill UI (React)
├── options/        # Options page (React)
├── shared/         # Types, storage, messaging, text utils
└── styles/         # Global styles (Tailwind v4)
```

## Development

```bash
# Watch mode (rebuilds on change)
pnpm dev

# Type checking
pnpm typecheck

# Linting
pnpm lint
```

## Roadmap

- **Milestone 2**: Local neural voices (Piper/Kokoro WASM)
- **Milestone 3**: Cloud TTS (ElevenLabs, OpenAI, Azure)
- **Future**: Word-level highlighting, code-block skipping, URL filters

## License

MIT
