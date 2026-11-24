/**
 * Safety filters for Arabic kids content. Conservative keyword-based
 * screening; a flagged result is blocked before it is shown or voiced.
 */

const UNSAFE_PATTERNS: RegExp[] = [
  /قتل|ذبح|血|血/g,
  /رعب|مرعب|خائف|كابوس/g,
  /جنس|إباح|عاري/g,
  /酒|مخدر|شذوذ/g,
  /انتحار|موت/g,
  /weapon|gun|knife|kill|murder|blood|horror|scary|nightmare|sex|drug|suicide/gi,
];

const TOO_SCARY_WORDS = [
  'وحش',
  'شبح',
  'زومبي',
  'monster',
  'ghost',
  'zombie',
];

export interface SafetyResult {
  safe: boolean;
  reasons: string[];
}

export function checkSafety(text: string): SafetyResult {
  const reasons: string[] = [];
  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(`matched ${pattern.source}`);
      pattern.lastIndex = 0;
    }
  }
  const lower = text.toLowerCase();
  for (const word of TOO_SCARY_WORDS) {
    if (lower.includes(word.toLowerCase())) {
      reasons.push(`scary word: ${word}`);
    }
  }
  // Age-appropriate length: very long unbroken text is suspicious for a kids story.
  if (text.length > 4000) reasons.push('text too long');
  return { safe: reasons.length === 0, reasons };
}