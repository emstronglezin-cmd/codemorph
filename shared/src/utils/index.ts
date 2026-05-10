// ============================================================
// CodeMorph — Shared Utilities
// ============================================================

// ── String Utilities ─────────────────────────────────────
export const slugify = (str: string): string =>
  str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const capitalize = (str: string): string =>
  str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();

export const truncate = (str: string, length: number, suffix = '...'): string =>
  str.length <= length ? str : `${str.slice(0, length - suffix.length)}${suffix}`;

export const camelToSnake = (str: string): string =>
  str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export const snakeToCamel = (str: string): string =>
  str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

// ── Date Utilities ────────────────────────────────────────
export const formatDate = (date: Date | string, locale = 'en-US'): string =>
  new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(date));

export const formatDateTime = (date: Date | string, locale = 'en-US'): string =>
  new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));

export const timeAgo = (date: Date | string): string => {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  const intervals = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'week', seconds: 604800 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
    { label: 'second', seconds: 1 },
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count !== 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
};

export const isExpired = (date: Date | string): boolean => new Date(date) < new Date();

// ── Object Utilities ──────────────────────────────────────
export const omit = <T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> => {
  const result = { ...obj };
  keys.forEach((key) => delete result[key]);
  return result;
};

export const pick = <T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> => {
  const result = {} as Pick<T, K>;
  keys.forEach((key) => {
    if (key in obj) result[key] = obj[key];
  });
  return result;
};

export const deepMerge = <T extends object>(target: T, source: Partial<T>): T => {
  const result = { ...target };
  Object.keys(source).forEach((key) => {
    const k = key as keyof T;
    if (
      source[k] !== null &&
      typeof source[k] === 'object' &&
      !Array.isArray(source[k]) &&
      typeof target[k] === 'object'
    ) {
      result[k] = deepMerge(target[k] as object, source[k] as object) as T[keyof T];
    } else if (source[k] !== undefined) {
      result[k] = source[k] as T[keyof T];
    }
  });
  return result;
};

// ── Array Utilities ───────────────────────────────────────
export const groupBy = <T>(arr: T[], key: keyof T): Record<string, T[]> =>
  arr.reduce(
    (acc, item) => {
      const group = String(item[key]);
      acc[group] = [...(acc[group] ?? []), item];
      return acc;
    },
    {} as Record<string, T[]>,
  );

export const unique = <T>(arr: T[]): T[] => [...new Set(arr)];

export const chunk = <T>(arr: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size),
  );

export const sortBy = <T>(arr: T[], key: keyof T, order: 'asc' | 'desc' = 'asc'): T[] =>
  [...arr].sort((a, b) => {
    const aVal = a[key];
    const bVal = b[key];
    const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return order === 'asc' ? comparison : -comparison;
  });

// ── Number Utilities ──────────────────────────────────────
export const formatBytes = (bytes: number, decimals = 2): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i] ?? 'Bytes'}`;
};

export const formatNumber = (num: number, locale = 'en-US'): string =>
  new Intl.NumberFormat(locale).format(num);

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const percentage = (value: number, total: number): number =>
  total === 0 ? 0 : Math.round((value / total) * 100);

// ── Validation Utilities ──────────────────────────────────
export const isEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const isUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

export const isEmpty = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
};

// ── Async Utilities ───────────────────────────────────────
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const retry = async <T>(
  fn: () => Promise<T>,
  attempts = 3,
  delay = 1000,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (attempts <= 1) throw error;
    await sleep(delay);
    return retry(fn, attempts - 1, delay * 2);
  }
};

export const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    ),
  ]);

// ── ID Generation ─────────────────────────────────────────
export const generateId = (): string =>
  Math.random().toString(36).substring(2) + Date.now().toString(36);

export const generateShortId = (length = 8): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// ── Pagination ────────────────────────────────────────────
export const buildPaginationMeta = (
  total: number,
  page: number,
  limit: number,
): {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
} => {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

// ── Type Guards ───────────────────────────────────────────
export const isString = (value: unknown): value is string => typeof value === 'string';
export const isNumber = (value: unknown): value is number => typeof value === 'number' && !isNaN(value);
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const isArray = <T>(value: unknown): value is T[] => Array.isArray(value);
export const isDefined = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined;
