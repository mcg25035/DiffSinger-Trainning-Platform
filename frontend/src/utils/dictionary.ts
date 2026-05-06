export interface Dictionary {
  id: string;
  name: string;
  phonemes: string[];
}

export function validateLyrics(lyrics: string, validPhonemes: Set<string>): { isValid: boolean; invalidWords: string[] } {
  const words = lyrics.split(/\s+/).filter(w => w.length > 0);
  const invalidWords = words.filter(w => !validPhonemes.has(w.toLowerCase()));
  return {
    isValid: invalidWords.length === 0,
    invalidWords
  };
}
