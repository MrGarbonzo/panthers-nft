/**
 * Moltbook Verification Challenge Parser
 *
 * Parses obfuscated math word problems from the Moltbook API.
 * If parsing fails for any reason, throws an error.
 * Callers MUST catch and skip — never submit a guessed answer.
 * 10 failed submissions = automatic account suspension.
 */

export class VerificationParseError extends Error {
  constructor(message: string, public readonly challengeText: string) {
    super(message);
    this.name = 'VerificationParseError';
  }
}

// ============ Number word maps ============

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

const MAGNITUDES: Record<string, number> = {
  hundred: 100, thousand: 1000,
};

const ALL_NUMBER_WORDS = new Set([
  ...Object.keys(ONES),
  ...Object.keys(TENS),
  ...Object.keys(MAGNITUDES),
]);

/** Collapse consecutive duplicate letters: "twenntyy" → "twenty" */
function dedup(s: string): string {
  return s.replace(/([a-z])\1+/g, '$1');
}

/** Look up a token in a word map, trying both raw and deduped forms */
function lookupNumber(token: string, map: Record<string, number>): number | undefined {
  if (map[token] !== undefined) return map[token];
  const d = dedup(token);
  if (map[d] !== undefined) return map[d];
  return undefined;
}

/** Check if a token is a number word (raw or deduped) */
function isNumberWord(token: string): boolean {
  return ALL_NUMBER_WORDS.has(token) || ALL_NUMBER_WORDS.has(dedup(token));
}

/** Check if a token matches a specific word (raw or deduped) */
function isMagnitude(token: string, word: string): boolean {
  return token === word || dedup(token) === word;
}

// ============ Operation keyword phrases ============
// Ordered by specificity (longest match first within each category)

interface OpPhrase {
  words: string[];
  op: '+' | '-' | '*' | '/';
}

const OP_PHRASES: OpPhrase[] = [
  // Subtraction
  { words: ['slows', 'by'], op: '-' },
  { words: ['slowed', 'by'], op: '-' },
  { words: ['decreases', 'by'], op: '-' },
  { words: ['decreased', 'by'], op: '-' },
  { words: ['subtracted', 'by'], op: '-' },
  { words: ['reduced', 'by'], op: '-' },
  { words: ['loses'], op: '-' },
  { words: ['lost'], op: '-' },
  { words: ['minus'], op: '-' },
  { words: ['subtract'], op: '-' },
  { words: ['less'], op: '-' },
  // Addition
  { words: ['speeds', 'up', 'by'], op: '+' },
  { words: ['increased', 'by'], op: '+' },
  { words: ['increases', 'by'], op: '+' },
  { words: ['gains'], op: '+' },
  { words: ['gained'], op: '+' },
  { words: ['plus'], op: '+' },
  { words: ['add'], op: '+' },
  { words: ['added'], op: '+' },
  // Multiplication
  { words: ['multiplied', 'by'], op: '*' },
  { words: ['times'], op: '*' },
  { words: ['multiply'], op: '*' },
  // Division
  { words: ['divided', 'by'], op: '/' },
  { words: ['split', 'by'], op: '/' },
  { words: ['divide'], op: '/' },
];

// ============ Parser ============

/**
 * Parse an obfuscated Moltbook verification challenge and return the numeric answer.
 * Throws VerificationParseError if the challenge cannot be confidently parsed.
 */
export function parseVerificationChallenge(challengeText: string): number {
  // Step 1 — Normalize
  let text = challengeText.toLowerCase();
  text = text.replace(/[\[\]^/]/g, '');
  // Remove `-` between letters (word-internal dash), keep `-` before digits
  text = text.replace(/(?<=[a-z])-(?=[a-z])/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  // Step 2 — Tokenize
  const tokens = text.split(' ').filter(t => t.length > 0);

  // Step 3 — Find operation and its position in the token stream
  let opResult: { op: '+' | '-' | '*' | '/'; startIdx: number; endIdx: number } | null = null;

  for (let i = 0; i < tokens.length; i++) {
    for (const phrase of OP_PHRASES) {
      if (i + phrase.words.length > tokens.length) continue;
      let match = true;
      for (let j = 0; j < phrase.words.length; j++) {
        if (tokens[i + j] !== phrase.words[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        opResult = { op: phrase.op, startIdx: i, endIdx: i + phrase.words.length };
        break;
      }
    }
    if (opResult) break;
  }

  if (!opResult) {
    throw new VerificationParseError('No operation keyword found', challengeText);
  }

  // Step 4 — Extract numbers from before and after the operation
  const tokensBefore = tokens.slice(0, opResult.startIdx);
  const tokensAfter = tokens.slice(opResult.endIdx);

  const firstNumber = extractNumber(tokensBefore);
  const secondNumber = extractNumber(tokensAfter);

  if (firstNumber === null) {
    throw new VerificationParseError('Could not find first number before operation', challengeText);
  }
  if (secondNumber === null) {
    throw new VerificationParseError('Could not find second number after operation', challengeText);
  }

  // Step 5 — Compute
  let result: number;
  switch (opResult.op) {
    case '+': result = firstNumber + secondNumber; break;
    case '-': result = firstNumber - secondNumber; break;
    case '*': result = firstNumber * secondNumber; break;
    case '/':
      if (secondNumber === 0) {
        throw new VerificationParseError('Division by zero', challengeText);
      }
      result = firstNumber / secondNumber;
      break;
  }

  if (!Number.isFinite(result)) {
    throw new VerificationParseError(`Result is not finite: ${result}`, challengeText);
  }

  return result;
}

/**
 * Format a numeric answer to exactly 2 decimal places as a string.
 * This is the format Moltbook expects in the verify endpoint.
 */
export function formatAnswer(n: number): string {
  return n.toFixed(2);
}

// ============ Number extraction helpers ============

/**
 * Scan a token array and extract a compound number.
 * Returns the last number found in the token sequence (closest to the operation).
 */
function extractNumber(tokens: string[]): number | null {
  const numbers: number[] = [];
  let i = 0;

  while (i < tokens.length) {
    const parsed = parseNumberAtPosition(tokens, i);
    if (parsed !== null) {
      numbers.push(parsed.value);
      i = parsed.nextIndex;
    } else {
      i++;
    }
  }

  if (numbers.length === 0) return null;
  // Return the last number found (the one closest to the operation keyword)
  return numbers[numbers.length - 1];
}

interface ParsedNumber {
  value: number;
  nextIndex: number;
}

/**
 * Try to parse a (possibly compound) number starting at position i.
 * Handles: "twenty five", "three hundred", "three hundred twenty five", "thousand", etc.
 */
function parseNumberAtPosition(tokens: string[], i: number): ParsedNumber | null {
  if (i >= tokens.length) return null;

  const token = tokens[i];

  // Check for a digit string (e.g. "20", "-5")
  if (/^-?\d+(\.\d+)?$/.test(token)) {
    return { value: Number(token), nextIndex: i + 1 };
  }

  // Must start with a number word (raw or deduped)
  if (!isNumberWord(token)) return null;
  if (lookupNumber(token, MAGNITUDES) !== undefined && i === 0) {
    return { value: lookupNumber(token, MAGNITUDES)!, nextIndex: i + 1 };
  }
  if (lookupNumber(token, MAGNITUDES) !== undefined) return null;

  let value = 0;
  let current = 0;
  let idx = i;

  // Parse compound number
  while (idx < tokens.length) {
    const t = tokens[idx];
    const onesVal = lookupNumber(t, ONES);
    const tensVal = lookupNumber(t, TENS);

    if (onesVal !== undefined) {
      current += onesVal;
      idx++;
    } else if (tensVal !== undefined) {
      current += tensVal;
      idx++;
      // Check if next token is a ones word (e.g. "twenty five")
      if (idx < tokens.length && lookupNumber(tokens[idx], ONES) !== undefined) {
        current += lookupNumber(tokens[idx], ONES)!;
        idx++;
      }
    } else if (isMagnitude(t, 'hundred')) {
      current *= 100;
      idx++;
    } else if (isMagnitude(t, 'thousand')) {
      current *= 1000;
      idx++;
    } else {
      break;
    }
  }

  if (idx === i) return null; // consumed nothing

  value += current;
  return { value, nextIndex: idx };
}
