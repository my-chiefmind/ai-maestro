/** Deterministic value helpers shared by pure policy and persistence adapters. */
import { createHash } from 'node:crypto';
import { BoardInputError } from './board-errors.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  const input = typeof value === 'string' ? value : canonical(value);
  return createHash('sha256').update(input).digest('hex');
}

export function requireValue(condition, message) {
  if (!condition) throw new BoardInputError(message);
}
