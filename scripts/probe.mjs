// Scratch probe: exercises prepareSpeech against the reported cases.
import { prepareSpeech, splitIntoSentences } from '../src/shared/text-utils.ts';

const CASES = [
  'Energy availability → understand agricultural urgency → optimize allocation → minimize water use, energy cost and food loss.',
  'The pipeline: upload → process → download, and then report.',
  'Move up ↑ down ↓ left ← right → and check ↔ ⇄ ⇅ ⇵ ⇨ ⇩ ⇦ ⇨',
  'The API returns JSON. HTML and CSS are parsed by the browser. URL and URI are also fine. ASIA IS OUT OF WATER TODAY.',
  'Mixed SHOUTED sentence with SOME ALL CAPS words and an OK reply.',
  'Visit https://example.com/docs or mail me at john.doe@sub.example.org for more.',
  'Costs fell 12% in Q3, rising to 45 units (Smith et al., 2020) versus [12, 13].',
  'a→b  x y  em—dash  “curly quotes” … ellipsis',
];

for (const input of CASES) {
  const plan = prepareSpeech(input);
  const srcTokens = input.match(/\S+/g) ?? [];
  console.log('IN  :', JSON.stringify(input));
  console.log('OUT :', JSON.stringify(plan.text));
  console.log('MAP :', plan.spokenToSource.join(','));
  console.log('SRC :', srcTokens.length, 'tokens;  SPOKEN:', plan.text.split(/\s+/).filter(Boolean).length);
  console.log('SENT:', JSON.stringify(splitIntoSentences(plan.text)));
  console.log('----');
}

// Which characters are the arrow-ish set, and are they Extended_Pictographic?
const arrows = ['→', '←', '↑', '↓', '↔', '⇄', '⇅', '⇵', '⇨', '⇩', '⇦', '➔', '»', '•', '·', '▪', '●', '◆', '★', '—', '–'];
console.log('=== emoji/pictographic probe ===');
for (const c of arrows) {
  const code = 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  const isEmoji = /\p{Extended_Pictographic}/u.test(c);
  const plan = prepareSpeech(`a ${c} b`);
  console.log(
    `${c}  ${code.padEnd(8)} EMOJI=${String(isEmoji).padEnd(5)} out=${JSON.stringify(plan.text)}`,
  );
}
