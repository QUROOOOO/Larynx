// Text utilities for sentence-aware TTS

export function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const abbreviationPattern = /\b(?:e\.g|i\.e|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|cf|al|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\./gi;
  
  const placeholder = '\u0001';
  const processed = normalized.replace(abbreviationPattern, (match) => match.replace('.', placeholder));
  
  // Split on sentence boundaries: punctuation followed by space and capital letter/quote/paren
  const sentences = processed.split(/(?<=[.!?])\s+(?=[A-Z"'()])/);
  
  return sentences.map(s => s.replace(new RegExp(placeholder, 'g'), '.').trim()).filter(Boolean);
}

export function estimateDuration(text: string, rate: number = 1.0): number {
  const charsPerSecond = 12.5 * rate;
  return (text.length / charsPerSecond) * 1000;
}

/* ------------------------------------------------------------------ *
 * Speech preparation
 *
 * `prepareSpeech` rewrites a raw selection into something a speech engine
 * can read out loud without the mangling that plain page text produces:
 * URLs, e-mail addresses, DOIs and citation markers are removed, and
 * initialisms are spelled out letter by letter.
 *
 * It is deliberately a pure, deterministic, dependency-free function. No
 * model, no network, no heuristic scoring — the same input always produces
 * the same plan, and every decision is traceable to a pattern below.
 *
 * The hard part is that the highlighter has to stay glued to the ORIGINAL
 * text while the engine reads a DIFFERENT text. The plan therefore carries
 * `spokenToSource`: for every token the engine will speak, the index of the
 * source token it came from. Tokens that expand (an initialism becoming
 * several letters) point at the same source token several times, so the
 * cursor walks across the letters of "API" while one source word lights up.
 *
 * Tokens that are dropped contribute no entry at all.
 * ------------------------------------------------------------------ */

export interface SpeechPlan {
  /** Spoken text: emitted tokens joined by single spaces. */
  text: string;
  /** `spokenToSource[i]` is the source token index behind spoken token `i`. */
  spokenToSource: number[];
}

/** Source tokens are the same units the highlighter wraps, so `/\S+/` is the contract. */
const SOURCE_TOKEN = /\S+/g;

/** Punctuation at the end of a match is kept so the sentence still ends. */
const SENTENCE_END = /[.!?]+$/;

const LEAD_PUNCT = /^[^\p{L}\p{N}]*/u;
const TRAIL_PUNCT = /[^\p{L}\p{N}]*$/u;

/** Emoji, their modifiers, flags, joiners and the emoji presentation selector. */
const EMOJI =
  /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200D|\uFE0F/gu;

/** HTML tags and entities left behind by a page that was not really HTML. */
const HTML_TAG = /<[^<>]{0,60}>/g;
const HTML_ENTITY = /&(?:#\d{1,5}|#[xX][0-9a-fA-F]{1,4}|[a-zA-Z]{2,10});/g;

/** Emphasis and list residue, only where a markup character would never be prose. */
const EDGE_MARKS = /^[*_~]+|[*_~]+$/g;
const HEADING_MARK = /^(?:#{1,6}|>|[-*+])(?=\S)/;
const TABLE_MARKS = /^[|\u2022\u25E6\u00B7]+|[|\u2022\u25E6\u00B7]+$/g;

interface DropPattern {
  re: RegExp;
  guard?: (match: RegExpExecArray) => boolean;
}

const TOP_LEVEL_DOMAINS =
  'com|org|net|edu|gov|mil|int|io|dev|ai|app|sh|gg|tv|me|co|info|biz|xyz|blog|' +
  'uk|de|fr|es|it|nl|be|at|ch|se|no|dk|fi|pl|cz|pt|ie|gr|ro|hu|ru|ua|tr|ua|' +
  'jp|kr|zh|hk|tw|in|sg|my|id|th|vn|ph|br|ar|cl|mx|ca|us|au|nz|za|ke|ng|il';

/**
 * Regions that are never read aloud. Every pattern here is structural —
 * something the engine would otherwise pronounce as a stream of letters —
 * so the blast radius of a false positive is a missing clause, not a
 * mangled word. Prose numbers, years, units, `e.g.`, `i.e.`, `etc.`, `vs.`
 * and figure/table references are intentionally NOT in this list.
 */
const DROP_PATTERNS: DropPattern[] = [
  { re: /\b(?:https?|ftp):\/\/[^\s<>"'`]+/gi },
  { re: /\bwww\.[^\s<>"'`]+/gi },
  { re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { re: /\b10\.\d{4,9}\/[^\s<>"'`]+/g },
  { re: /\barXiv[:\s]?\s*\d{4}\.\d{4,5}(?:v\d+)?/gi },
  { re: /\bdoi:\s*10\.\d{4,9}\/[^\s<>"'`]+/gi },
  // "et al." on its own, and the year that usually trails it.
  { re: /\bet\s+al\.?(?:\s*,\s*(?:\(\s*(?:19|20)\d{2}[a-z]?\s*\)|\d{4}[a-z]?))?/gi },
  // "(Smith et al., 2020)" and any parenthesis that contains one.
  { re: /\([^()]*\bet\s+al\.[^()]*\)/gi },
  // "(Smith, 2020)" / "(Smith & Jones, 1999a)".
  {
    re: /\(\s*\p{Lu}\p{L}*[\p{L}'’-]*(?:\s+(?:et\s+al\.|and|&)\s+\p{Lu}[\p{L}'’-]+)*\s*,\s*(?:19|20)\d{2}[a-z]?\s*[,;]?\s*\)/gu,
  },
  // "[12]", "[3, 4]", "[5-9]".
  { re: /\[\s*\d+(?:\s*[-–,]\s*\d+)*\s*\]/g },
  // "[Smith et al., 2020]" — a bracketed year only counts as a citation when
  // it also carries a name or a comma.
  {
    re: /\[[^[\]]{0,80}\b(?:19|20)\d{2}[a-z]?\b[^[\]]{0,80}\]/g,
    guard: m => /et\s+al\.|[A-Z][a-z]+,/.test(m[0]),
  },
  // Bare domains: the TLD whitelist is what keeps "3.14" and "e.g." safe.
  {
    re: new RegExp(
      `\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TOP_LEVEL_DOMAINS})\\b(?:/[^\\s]*)?`,
      'gi',
    ),
  },
];

/**
 * Roman numerals are the commonest false positive for an initialism pass —
 * "XI" in a list is eleven, not ex-eye.
 */
const ROMAN_NUMERALS = /^[IVXLCDM]+$/;

/**
 * Acronyms the engine already reads as a word. Spelling these out produces
 * invented syllables ("A S A P" instead of "asap").
 */
const WORD_LIKE_ACRONYMS = new Set([
  'AK', 'ASAP', 'AWOL', 'BFF', 'BRB', 'DIY', 'ETA', 'FAQ', 'FYI', 'IMHO', 'IMO',
  'OK', 'OMG', 'RSVP', 'SOS', 'TBA', 'TBD', 'TTYL', 'WTF', 'YOLO',
  'ASCII', 'CSS', 'HTML', 'HTTPS', 'HTTP', 'URL', 'URI', 'XML', 'SQL', 'DNS',
  'SSL', 'TLS', 'FTP', 'SSH', 'TCP', 'UDP', 'USB', 'LAN', 'WAN', 'PDA', 'GPS',
  'PDF', 'PNG', 'JPG', 'JPEG', 'GIF', 'SVG', 'CPU', 'GPU', 'RAM', 'ROM', 'SDK',
  'IDE', 'UI',
  'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CIO', 'CISO', 'CIA', 'FBI', 'NASA', 'NATO',
  'UNESCO', 'WTO', 'IMF', 'HIV', 'AIDS', 'LASER', 'RADAR', 'SONAR', 'MOON',
]);

/**
 * Ordinary words that happen to be typed in capitals because someone is
 * shouting. Expanding these would spell out a sentence.
 */
const SHOUTED_WORDS = new Set([
  'A', 'I', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE', 'IF', 'IN', 'IS',
  'IT', 'ME', 'MY', 'NO', 'OF', 'ON', 'OR', 'SO', 'TO', 'UP', 'US', 'WE',
  'THE', 'AND', 'BUT', 'FOR', 'ARE', 'NOT', 'YOU', 'ALL', 'CAN', 'HAD', 'HAS',
  'HER', 'HIM', 'HIS', 'HOW', 'ITS', 'MAY', 'NEW', 'NOW', 'ONE', 'OUR', 'OUT',
  'SAY', 'SEE', 'SHE', 'TOO', 'TWO', 'USE', 'WAS', 'WAY', 'WHO', 'WHY', 'YES',
  'HELP', 'STOP', 'WAIT', 'LOOK', 'LIKE', 'WORK', 'MAKE', 'TAKE', 'COME',
  'GIVE', 'HAVE', 'KNOW', 'THINK', 'WELL', 'JUST', 'ALSO', 'VERY', 'ONLY',
  'THEN', 'THAN', 'WHEN', 'WHERE', 'WHICH', 'WITH', 'YOUR', 'THEM', 'THESE',
  'THOSE', 'BEEN', 'WILL', 'WOULD', 'COULD', 'SHOULD', 'MUST', 'EACH', 'SOME',
  'MORE', 'MOST', 'MANY', 'MUCH', 'SUCH', 'BOTH', 'FEW', 'GOOD', 'BEST',
  'GREAT', 'BAD', 'SURE', 'OKAY', 'OH', 'AH', 'HI', 'HEY', 'BYE', 'WOW',
  'OOPS', 'SLOW', 'FAST', 'RUN', 'TRY', 'ASK', 'TELL', 'CALL', 'TALK', 'READ',
  'WRITE', 'PLAY', 'SEND', 'FIND', 'KEEP', 'MOVE', 'LIVE', 'LOVE', 'HATE',
  'FEEL', 'NEED', 'WANT', 'DOES', 'DID', 'DON', 'CANNOT', 'WON', 'SHALL',
]);

/**
 * A citation number welded to the word before it. `Selection.toString()`
 * flattens `<sup>` away, so the structure is gone and all that is left is a
 * digit run fused to a word with no space: `study12`, `theory,7`, `groups5a`.
 * The case pattern is the filter — `COVID19` and `HTML5` are kept.
 */
const SUPERSCRIPT_CITATION =
  /^(?:\p{Lu}\p{Ll}{2,}|\p{Ll}{3,})[',]?\d{1,2}\p{Ll}?(?:,\d{1,2}\p{Ll}?)*$/u;

/** Figure and table callouts are numbers with meaning, not citation numbers. */
const NAMED_REFERENCE =
  /^(?:FIG(?:URE)?|TAB(?:LE)?|EQ(?:UATION)?|SEC(?:TION)?|APP(?:ENDIX)?|CH(?:APTER)?|EX(?:AMPLE)?|NOTE|DEF(?:INITION)?|CLASS|VOL|V|P|PP)\d{1,3}$/i;

interface SourceToken {
  text: string;
  start: number;
  end: number;
}

/** Returns the letters of an initialism, or null when the token is not one. */
function spellOut(core: string): string[] | null {
  if (core.length < 2 || core.length > 10) return null;
  if (!/^[A-Z]+$/.test(core)) return null;
  if (ROMAN_NUMERALS.test(core)) return null;
  if (WORD_LIKE_ACRONYMS.has(core)) return null;
  if (SHOUTED_WORDS.has(core)) return null;
  return core.split('');
}

/**
 * Strips markup residue and emoji from a single token, leaving prose and the
 * punctuation that carries sentence structure.
 */
function scrubToken(value: string): string {
  let out = value.replace(HTML_TAG, '').replace(HTML_ENTITY, '');
  if (HEADING_MARK.test(out)) out = out.replace(HEADING_MARK, '');
  out = out.replace(EDGE_MARKS, '').replace(TABLE_MARKS, '');
  return out.replace(EMOJI, '').trim();
}

/**
 * Builds the plan for one selection.
 *
 * The returned text is the emitted tokens joined by single spaces, so
 * re-tokenising it with `/\S+/g` reproduces the token list exactly. That is
 * what lets the offscreen sequencer keep counting words without knowing that
 * anything was rewritten here.
 */
export function prepareSpeech(source: string): SpeechPlan {
  const tokens: SourceToken[] = [];
  SOURCE_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_TOKEN.exec(source)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }

  if (tokens.length === 0) return { text: '', spokenToSource: [] };

  // Character ranges to excise, found against the raw string so a pattern can
  // straddle several tokens.
  const cuts: Array<{ start: number; end: number }> = [];
  for (const pattern of DROP_PATTERNS) {
    pattern.re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = pattern.re.exec(source)) !== null) {
      if (hit[0].length === 0) {
        pattern.re.lastIndex += 1;
        continue;
      }
      if (pattern.guard && !pattern.guard(hit)) continue;
      const start = hit.index;
      // Keep a trailing sentence end so dropping a URL does not merge the
      // sentence it closed into the next one.
      const tail = SENTENCE_END.exec(hit[0])?.[0] ?? '';
      cuts.push({ start, end: start + hit[0].length - tail.length });
    }
  }
  cuts.sort((a, b) => a.start - b.start);

  const spoken: string[] = [];
  const spokenToSource: number[] = [];

  const emit = (value: string, sourceIndex: number) => {
    spoken.push(value);
    spokenToSource.push(sourceIndex);
  };

  tokens.forEach((token, index) => {
    let value = token.text;

    // Apply every cut that overlaps this token.
    let cursor = token.start;
    let cut = '';
    for (const range of cuts) {
      if (range.end <= token.start) continue;
      if (range.start >= token.end) break;
      const from = Math.max(range.start, cursor);
      const to = Math.min(range.end, token.end);
      if (to <= from) continue;
      cut += source.slice(cursor, from);
      cursor = to;
    }
    if (cursor !== token.start || cut !== token.text) {
      value = cut + source.slice(cursor, token.end);
    }

    value = scrubToken(value);
    if (!value) return;

    // Punctuation on its own is layout, not language — except a sentence end,
    // which the split still needs in order to breathe.
    if (!/[\p{L}\p{N}]/u.test(value) && !SENTENCE_END.test(value)) return;

    if (SUPERSCRIPT_CITATION.test(value) && !NAMED_REFERENCE.test(value)) return;

    const lead = LEAD_PUNCT.exec(value)?.[0] ?? '';
    const trail = TRAIL_PUNCT.exec(value)?.[0] ?? '';
    const core = value.slice(lead.length, value.length - trail.length);
    const letters = core ? spellOut(core) : null;

    if (!letters || letters.length === 0) {
      emit(value, index);
      return;
    }

    const first = lead + letters[0];
    const last = letters.length === 1 ? first : letters[letters.length - 1] + trail;
    for (let i = 0; i < letters.length; i += 1) {
      if (i === 0) emit(first, index);
      else if (i === letters.length - 1) emit(last, index);
      else emit(letters[i], index);
    }
  });

  if (spoken.length === 0) {
    // Everything was swallowed (a selection that was only links, say). Speaking
    // the source verbatim beats saying nothing at all, and the identity map
    // keeps the highlighter honest.
    return {
      text: tokens.map(t => t.text).join(' '),
      spokenToSource: tokens.map((_, i) => i),
    };
  }

  return { text: spoken.join(' '), spokenToSource };
}
