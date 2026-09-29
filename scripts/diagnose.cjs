// Diagnostic driver: runs the REAL built content script against a real page and
// checks three things the user complained about:
//   1. does the page text survive wrapping byte-for-byte?
//   2. does spoken word N light up the word that was actually spoken?
//   3. what does the ::selection / gap situation look like?
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(REPO, 'dist/content.js'), 'utf8');
const PAGE = 'file://' + path.join(REPO, 'scripts/harness.html').replace(/\\/g, '/');

const CHROME_MOCK = `
window.__harness = { sent: [], listeners: [] };
window.chrome = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => { window.__harness.sent.push(msg); if (cb) cb({ success: true }); },
    onMessage: { addListener: (fn) => window.__harness.listeners.push(fn) },
  },
};
window.__harness.dispatch = (msg) =>
  window.__harness.listeners.forEach((fn) => { try { fn(msg, {}, () => {}); } catch (e) { window.__harness.listenerError = String(e); } });
`;

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.addInitScript(CHROME_MOCK);
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(PAGE);

  await page.addScriptTag({ content: CONTENT });

  const sections = await page.evaluate(() => {
    return ['p1', 'p2', 'p3a', 'p3b', 'p3c', 'p3d', 'p4', 'p5'].map((id) => {
      const el = document.getElementById(id);
      const range = document.createRange();
      range.selectNodeContents(el);
      return { id, sel: range.toString(), len: range.toString().length };
    });
  });

  const report = [];

  for (const s of sections) {
    const out = await page.evaluate(
      ({ id, sel }) => {
        const el = document.getElementById(id);
        const before = document.body.innerText;

        const range = document.createRange();
        range.selectNodeContents(el);
        const selObj = window.getSelection();
        selObj.removeAllRanges();
        selObj.addRange(range);

        window.__harness.sent.length = 0;
        window.__larynx.run();

        const msg = window.__harness.sent.find((m) => m.type === 'SELECTION');
        const after = document.body.innerText;

        // Word spans the script actually created, in order.
        const wordSpans = [...document.querySelectorAll('.larynx-word')].map((s) => s.textContent);
        const gapTexts = [...document.querySelectorAll('.larynx-gap')].map((s) => JSON.stringify(s.textContent));

        // Simulate the offscreen sequencer: emit every spoken index and record
        // which source word ends up painted.
        const state = window.__larynx;
        const spoken = (msg && msg.payload.text ? msg.payload.text : '').split(/\s+/).filter(Boolean);
        const painted = [];
        for (let i = 0; i < spoken.length; i += 1) {
          window.__harness.dispatch({
            type: 'WORD_PROGRESS',
            payload: { wordIndex: i, sentenceIndex: 0, wordText: spoken[i] },
          });
          const el2 = document.querySelector('.larynx-word.larynx-word-active');
          painted.push(el2 ? el2.textContent : null);
        }

        return {
          id,
          selectionText: sel,
          textPreserved: before === after,
          spokenText: msg ? msg.payload.text : null,
          spokenCount: spoken.length,
          wordSpanCount: wordSpans.length,
          sourceWordCount: (sel.match(/\S+/g) || []).length,
          map: state.spokenToSource,
          firstGaps: gapTexts.slice(0, 8),
          pairs: spoken.slice(0, 40).map((w, i) => `${w}  ->  ${painted[i]}`),
          listenerError: window.__harness.listenerError || null,
        };
      },
      { id: s.id, sel: s.sel },
    );
    report.push(out);
  }

  console.log(JSON.stringify(report, null, 2));
  if (logs.length) console.log('\n--- console ---\n' + logs.join('\n'));
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
