export interface ParseOptions {
  geminate?: string;
  maxParses?: number;
}

export declare function enumerateParses(w: string, geminate?: string, maxParses?: number): string[][];
export declare const ALIASES: Record<string, string>;
export declare const ONSETS: string[];
export declare const VOWELS: string;
