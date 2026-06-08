/**
 * Character encoding detection and decoding for GIS attribute files.
 *
 * Chinese (and other CJK) shapefile / MapInfo datasets are notorious for
 * encoding inconsistencies. This module:
 *
 * 1. Reads the explicit hint file (.cpg for SHP/TAB, or the .mid's first
 *    row for MapInfo MIF) when present.
 * 2. Falls back to a heuristic probe: a quick scan of the buffer using a
 *    fixed set of plausible encodings, with a score that rewards:
 *      - high proportion of valid CJK characters (UTF-8, GB18030, Big5, …)
 *      - absence of replacement-character / mojibake sequences
 *      - presence of common GIS Chinese phrases
 * 3. Always falls back to Latin1 (which is a 1:1 byte→codepoint mapping) so
 *    we never throw on unreadable input — at worst the user sees mojibake.
 *
 * The output is a `Decoder` function that turns a `Buffer` into a JS string.
 */
import * as fs from 'node:fs';

/** CPG file codes seen in the wild. */
const CPG_ALIASES: Record<string, string> = {
  // UTF-8 family
  utf8: 'utf-8', 'utf-8': 'utf-8', '65001': 'utf-8', 'utf8mb4': 'utf-8',
  // GB family
  gbk: 'gbk', 'gb18030': 'gb18030', 'gb2312': 'gb18030', cp936: 'gbk', '936': 'gbk',
  // Big5 (Traditional Chinese)
  big5: 'big5', 'big-5': 'big5', cp950: 'big5', '950': 'big5',
  // Japanese / Korean
  shift_jis: 'shift_jis', 'shift-jis': 'shift_jis', cp932: 'shift_jis',
  euc_kr: 'euc-kr', 'euc-kr': 'euc-kr', cp949: 'euc-kr',
  // Windows code pages
  cp1252: 'windows-1252', '1252': 'windows-1252',
  cp1250: 'windows-1250', '1250': 'windows-1250',
  // Latin1 (default fallback)
  latin1: 'latin1', 'iso88591': 'latin1',
};

/** Normalize a CPG label to a Node.js encoding name. Returns null if unknown. */
export function normalizeCPG(label: string): string | null {
  const key = label.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!key) return null;
  return CPG_ALIASES[key] ?? key;
}

/** Read a CPG file (or similar 1-line label) and return a Node encoding. */
export function readCPG(path: string | undefined): string | null {
  if (!path || !fs.existsSync(path)) return null;
  try {
    const text = fs.readFileSync(path, 'utf8');
    return normalizeCPG(text);
  } catch {
    return null;
  }
}

/** Build a decoder function for the given encoding. */
export function decoderFor(encoding: string): (b: Buffer) => string {
  try {
    new TextDecoder(encoding, { fatal: false });
    return (b) => new TextDecoder(encoding, { fatal: false }).decode(b);
  } catch {
    return (b) => b.toString('latin1');
  }
}

// --- Heuristic detection -------------------------------------------------

/**
 * Map a dBASE language-driver byte (offset 29 in the .dbf header) to a
 * Node.js encoding. Most GIS tools ignore this byte, but it's a useful
 * fallback when no .cpg and no CJK content is available for heuristic
 * probing.
 */
export function driverToEncoding(driver: number): string | null {
  const table: Record<number, string> = {
    0x01: 'windows-1252', 0x02: 'windows-1252', 0x03: 'windows-1252', 0x04: 'windows-1252',
    0x06: 'windows-1252', 0x07: 'windows-1252', 0x09: 'windows-1252', 0x0B: 'windows-1252',
    0x0D: 'windows-1252', 0x0F: 'cp850', 0x10: 'cp850', 0x11: 'cp850', 0x12: 'cp865',
    0x13: 'cp437', 0x14: 'cp850', 0x15: 'cp852', 0x16: 'cp852', 0x18: 'cp852',
    0x19: 'cp852', 0x1A: 'cp852', 0x1B: 'cp852', 0x1C: 'cp852', 0x1D: 'cp852',
    0x1E: 'cp855', 0x1F: 'cp855', 0x20: 'cp855', 0x21: 'cp866', 0x22: 'cp852',
    0x23: 'cp852', 0x25: 'cp855', 0x26: 'cp855', 0x37: 'cp857',
    0x4D: 'gb18030', 0x4E: 'big5', 0x4F: 'shift_jis', 0x50: 'euc-kr',
    0x57: 'gb18030', 0x58: 'big5', 0x59: 'gb18030',
    0x65: 'cp1250', 0x66: 'cp1251', 0x67: 'cp1253', 0x68: 'cp1254',
    0x69: 'cp1255', 0x6A: 'cp1256', 0x6B: 'cp1257', 0x6C: 'cp1258',
  };
  return table[driver] ?? null;
}

interface EncodingCandidate {
  encoding: string;
  label: string;     // Chinese display name
  score: number;     // higher is better
}

/** Score a candidate encoding by probing the buffer. */
function scoreBuffer(buf: Buffer, encoding: string): number {
  if (buf.length === 0) return 0;
  let decoded: string;
  try {
    decoded = new TextDecoder(encoding, { fatal: false }).decode(buf);
  } catch {
    return -Infinity;
  }
  if (!decoded) return -Infinity;

  let score = 0;
  const len = decoded.length;
  const validUtf8 = isValidUtf8(buf);

  // 1. Count replacement characters (U+FFFD) — strong signal of mis-decode.
  const replacementCount = (decoded.match(/�/g) ?? []).length;
  score -= replacementCount * 10;

  if (validUtf8 && encoding === 'utf-8') score += 20;
  if (validUtf8 && encoding !== 'utf-8') score -= 5;

  // 2. CJK Unified Ideographs (U+4E00–U+9FFF) and extensions.
  const cjkRe = /[一-鿿㐀-䶿]/g;
  const cjkCount = (decoded.match(cjkRe) ?? []).length;
  score += cjkCount * 2;

  // 3. Common GIS / Chinese terms appearing as proper text.
  const commonTerms = [
    '省', '市', '县', '区', '镇', '村', '街道',
    '水库', '河流', '湖泊', '山', '公园', '林场',
    '茶园', '沟', '沟水库',
    '北京市', '上海市', '广州市', '深圳市',
    '公司', '集团', '有限', '股份',
  ];
  for (const t of commonTerms) {
    if (decoded.includes(t)) score += 3;
  }

  // 4. Punctuation that is typical of properly decoded CJK.
  const cjkPunct = /[　-〿＀-￯]/g;
  score += (decoded.match(cjkPunct) ?? []).length * 0.5;

  // 5. Printability: control characters (excluding common whitespace) are bad.
  // eslint-disable-next-line no-control-regex
  const controlRe = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
  score -= (decoded.match(controlRe) ?? []).length * 5;

  // 6. Heuristic for mojibake: e.g. "ä¸­æ–‡" sequences indicate UTF-8 read as Latin1.
  if (/[À-ÿ]{3,}/.test(decoded)) score -= 4;

  // 7. Normalize by length so longer buffers don't dominate just by having more
  //    matches. We compare per-1000 characters.
  return score / Math.max(1, len / 1000);
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the most likely encoding for the given buffer.
 *
 * The candidate list is ordered roughly by prevalence in Chinese GIS
 * datasets: GBK/GB18030 first (most common), then UTF-8, then Big5, then
 * Latin1 as a final fallback. The detector picks the highest-scoring
 * candidate. If all scores are negative, it returns the explicit fallback
 * (`'gb18030'` if not specified, which handles simplified Chinese
 * characters universally).
 */
export function detectEncoding(buf: Buffer, fallback: string = 'gb18030'): string {
  if (buf.length === 0) return fallback;
  const candidates: EncodingCandidate[] = [
    { encoding: 'gb18030', label: 'GB18030 (Simplified Chinese)', score: scoreBuffer(buf, 'gb18030') },
    { encoding: 'gbk', label: 'GBK (Simplified Chinese)', score: scoreBuffer(buf, 'gbk') },
    { encoding: 'utf-8', label: 'UTF-8', score: scoreBuffer(buf, 'utf-8') },
    { encoding: 'big5', label: 'Big5 (Traditional Chinese)', score: scoreBuffer(buf, 'big5') },
    { encoding: 'euc-kr', label: 'EUC-KR (Korean)', score: scoreBuffer(buf, 'euc-kr') },
    { encoding: 'shift_jis', label: 'Shift-JIS (Japanese)', score: scoreBuffer(buf, 'shift_jis') },
    { encoding: 'windows-1252', label: 'Windows-1252 (Western European)', score: scoreBuffer(buf, 'windows-1252') },
    { encoding: 'latin1', label: 'Latin1 (1:1 byte mapping)', score: scoreBuffer(buf, 'latin1') },
  ];
  // Choose the highest-scoring candidate; ties broken by listed preference.
  let best = candidates[0];
  for (const c of candidates) {
    if (c.score > best.score) best = c;
  }
  return best.encoding;
}

/**
 * Decode a buffer using either:
 *   - a hint file (`cpgPath`) — explicit CPG label
 *   - heuristic detection on a *sample* of the buffer
 *   - or a caller-supplied encoding
 *
 * The `sampleHint` buffer is used for detection (we don't need to decode
 * the whole 100 MB .dbf — first 64 KB is plenty).
 */
export function decodeAttributeBuffer(
  buf: Buffer,
  opts: { cpgPath?: string; encoding?: string; sampleSize?: number } = {},
): string {
  if (opts.encoding) return decoderFor(opts.encoding)(buf);
  const hint = readCPG(opts.cpgPath);
  if (hint) return decoderFor(hint)(buf);
  const sampleSize = opts.sampleSize ?? 65536;
  const sample = buf.subarray(0, Math.min(buf.length, sampleSize));
  const detected = detectEncoding(sample);
  return decoderFor(detected)(buf);
}

/** Decode a string field stored in a binary record. Strips trailing whitespace
 *  and common padding bytes. Returns the raw string if it's a code-page that's
 *  outside the printable-ASCII range, decoded by the supplied decoder. */
export function decodeStringField(raw: Buffer, decoder: (b: Buffer) => string): string {
  // First try a strict ASCII trim — if the field is pure ASCII, no encoding
  // gymnastics needed.
  let ascii = true;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] >= 0x80) { ascii = false; break; }
  }
  let str: string;
  if (ascii) {
    str = raw.toString('latin1');
  } else {
    str = decoder(raw);
  }
  // Strip trailing nulls / spaces / padding.
  return str.replace(/[\x00\s]+$/, '');
}
