/** Text helpers shared by input normalization, messages and projections. Pure functions. */

const INVISIBLE_RE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const LEADING_WRAP_RE = /^[<("'`[{「『]+/;
const TRAILING_WRAP_RE = /[>)"'`\]}.,;:!?、。」』]+$/;

/** Normalize a pasted ID, handle or URL: NFKC (full-width IME input), invisible characters, controls, wrapping punctuation. */
export function cleanText(input: string): string {
  const normalized = input.normalize('NFKC').replace(INVISIBLE_RE, '').replace(CONTROL_RE, ' ').trim();
  return normalized.replace(LEADING_WRAP_RE, '').replace(TRAILING_WRAP_RE, '').trim();
}

export type Cut = { text: string; truncated?: true };

/** Cut a string to at most `max` Unicode code points, appending an ellipsis when it was longer. */
export function cut(input: string, max: number): Cut {
  const codePoints = Array.from(input);
  if (codePoints.length <= max) return { text: input };
  return { text: `${codePoints.slice(0, max).join('')}…`, truncated: true };
}

const ECHO_MAX = 80;

/** Render caller input inside an error message: no control characters, collapsed whitespace, at most 80 characters. */
export function echo(input: string): string {
  const flat = input.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const codePoints = Array.from(flat);
  return codePoints.length <= ECHO_MAX ? flat : `${codePoints.slice(0, ECHO_MAX - 1).join('')}…`;
}
