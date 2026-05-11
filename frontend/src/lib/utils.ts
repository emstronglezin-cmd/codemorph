// ============================================================
// CodeMorph — Frontend Utilities
// ============================================================
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes safely */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format bytes to human-readable string */
export function fmtBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  const k     = 1024;
  const dm    = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i     = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/** Format ISO date string to locale */
export function fmtDate(iso: string, locale = 'fr-FR'): string {
  return new Date(iso).toLocaleDateString(locale, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

/** Format ISO date to relative time (e.g., "il y a 3 min") */
export function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s    = Math.floor(diff / 1000);
  const m    = Math.floor(s / 60);
  const h    = Math.floor(m / 60);
  const d    = Math.floor(h / 24);

  if (s < 60)  return `il y a ${s}s`;
  if (m < 60)  return `il y a ${m}min`;
  if (h < 24)  return `il y a ${h}h`;
  if (d < 7)   return `il y a ${d}j`;
  return fmtDate(iso);
}

/** Truncate string with ellipsis */
export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + '…';
}

/** Generate initials from a name */
export function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** Sleep (for use in async functions) */
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Check if running in browser */
export const isBrowser = typeof window !== 'undefined';

/** Safe JSON parse with fallback */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
