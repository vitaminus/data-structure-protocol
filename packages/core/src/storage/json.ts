export type SafeJsonParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      value: T;
    };

export function safeJsonParse<T>(value: string | null, fallback: T): SafeJsonParseResult<T> {
  if (!value) {
    return { ok: true, value: fallback };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(value) as T
    };
  } catch {
    return {
      ok: false,
      value: fallback
    };
  }
}
