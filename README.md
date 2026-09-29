# Larynx

> **Select any text on the web, hear it in a natural voice — instantly.**

Larynx is a lightweight, privacy-first Chrome extension that transforms any highlighted webpage text into natural, spoken audio with live word-by-word highlighting. Zero cloud subscriptions, zero tracking, and zero background memory when idle.

---

## What It Is

When reading long articles, documentation, academic papers, or emails, listening while following along improves comprehension, reading speed, and focus.

Traditional text-to-speech tools are clunky: they inject disruptive overlay widgets, require expensive monthly subscriptions, send your browsing data to remote servers, or break when reading symbols, citations, and complex page layouts.

**Larynx eliminates all friction:**
- **Zero-Latency Audio**: Select text, press `Ctrl+Shift+S` (`Cmd+Shift+S` on macOS), and hear it read aloud immediately.
- **In-Place Word Highlighting**: Each word lights up in real-time as it is spoken, keeping your eyes perfectly locked to the text without shifting page layout or conflicting with dark/light themes.
- **100% Private & Local**: Powered by your browser's built-in Web Speech synthesis engine. Audio is synthesized entirely on your device. No microphones, no recordings, no cloud APIs, and no telemetry.
- **Smart Text Normalization**: Automatically skips noisy URLs, emails, citations (`[1, 2]`), superscript numbers, and layout arrows, while keeping the visual highlighter locked to the source text.
- **Zero Idle Memory**: Built strictly on Manifest V3. The service worker is purely event-driven, and audio workers self-terminate after 30 seconds of inactivity.

---

## How It Works

### 1. User Experience Workflow

```
1. Select Text              2. Press Shortcut           3. Follow Along
┌────────────────────────┐  ┌────────────────────────┐  ┌────────────────────────┐
│ The quick brown fox    │  │   [Ctrl + Shift + S]   │  │ The [quick] brown fox  │
│ jumps over the lazy dog│─▶│                        │─▶│ jumps over the lazy dog│
└────────────────────────┘  └────────────────────────┘  └────────────────────────┘
                                                         (Spoken word highlights)
```

1. **Highlight any text** on any website or iframe.
2. **Press `Ctrl+Shift+S`** (or `Cmd+Shift+S` on macOS).
3. **Listen & Follow**: The extension speaks the selection, illuminating each spoken word in real-time.
4. **Pause / Resume**: Press the same shortcut while playing to toggle pause/resume. Selecting new text immediately switches to reading the new selection.

---

### 2. Architecture & System Flow

```
                                  CHROME EXTENSION PIPELINE
                                  
  ┌────────────────────────┐
  │   User Selects Text    │
  └───────────┬────────────┘
              │ Shortcut Pressed (Ctrl+Shift+S)
              ▼
  ┌────────────────────────────────────────────────────────┐
  │              Background Service Worker                 │
  │  - Event-driven (MV3) with zero persistent idle loops  │
  │  - Identifies active tab & targeted frame (iframes)    │
  │  - Spawns offscreen audio document on-demand           │
  │  - Stamps monotonic runId to isolate active playback   │
  └───────────┬────────────────────────────────────────────┘
              │
      ┌───────┴────────────────────────────────┐
      ▼                                        ▼
┌───────────────────────────┐    ┌───────────────────────────────────┐
│     Content Script        │    │        Offscreen Document         │
│  (Injected into Frame)    │    │       (Audio Synthesis Engine)    │
├───────────────────────────┤    ├───────────────────────────────────┤
│ • Clones exact text range │    │ • Splits text into sentences      │
│ • Wraps words into spans  │    │ • Tracks word boundary timings    │
│ • Applies accent highlight│    │ • Fallback tempo clock if engine  │
│ • Lossless DOM unwrap on  │    │   provides sparse boundary events │
│   speech end or cancel    │    │ • Auto-closes after 30s idle      │
└─────────────▲─────────────┘    └─────────────────┬─────────────────┘
              │                                    │
              └──────── Word Progress Event ───────┘
```

#### How the Components Interact:

1. **Selection Capture & Range Protection**:
   The content script detects the user's highlighted text range across any page or iframe. Before touching the DOM, it snapshots character boundaries and normalizes text for speech (cleaning bare URLs, bracketed citations, and acronyms).

2. **DOM Spanning & Highlighting**:
   The selected range is wrapped into discrete word elements without changing the host page's formatting, font size, or line height. When an audio progress event arrives, the active word span receives a vibrant glowing accent style.

3. **Offscreen Audio Synthesis**:
   Manifest V3 service workers cannot access audio output directly. Larynx uses an on-demand Chrome Offscreen Document hosting the browser's `SpeechSynthesis` engine. Speech is processed sentence-by-sentence to maintain natural cadence and intonation contours.

4. **Speech-to-Source Synchronization**:
   Speech engines can emit irregular boundary timings depending on the operating system voice. Larynx features a monotonic word sequencer that pairs real engine boundary events with dynamic rate estimation, ensuring the highlight never gets stuck or skips words.

5. **Lossless Restoration**:
   Once speech finishes or is interrupted, all injected spans are automatically unwrapped and adjacent text nodes are unified via DOM normalization. The webpage is restored byte-for-byte to its original condition.

---

## Controls & Customization

Customize everything via the built-in Options page:

| Feature | Description |
| :--- | :--- |
| **Voice Selection** | Choose from any installed system or browser voice. Natural/Neural voices are automatically detected and ranked. |
| **Pace Control** | Calibrated rate slider (0.5× to 2.0×) with live words-per-minute (WPM) estimation and quick preset buttons. |
| **Sentence Breathing** | Fine-tune pause duration between sentences (0 to 600 ms) for optimal listening comprehension. |
| **Punctuation Breathing** | Toggle natural micro-pauses at commas, colons, and semicolons. |
| **Custom Shortcut** | Remap the reading key chord directly within the options page or via `chrome://extensions/shortcuts`. |
| **Interactive Test Bench**| Preview your active voice, speed, and real-time word highlighting directly inside the options interface. |
