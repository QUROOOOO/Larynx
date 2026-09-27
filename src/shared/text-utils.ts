// Text utilities for sentence-aware TTS

export function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const abbreviationPattern = /\b(?:e\.g|i\.e|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|cf|al|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\./gi;
  
  let processed = normalized.replace(abbreviationPattern, (match) => match.replace('.', '\u0001'));
  
  const sentences = processed.split(/(?<=[.!?])\s+(?=[A-Z\"'\(\)])/);
  
  return sentences.map(s => s.replace(/\u0001/g, '.').trim()).filter(Boolean);
}

export function estimateDuration(text: string, rate: number = 1.0): number {
  const charsPerSecond = 12.5 * rate;
  return (text.length / charsPerSecond) * 1000;
}
