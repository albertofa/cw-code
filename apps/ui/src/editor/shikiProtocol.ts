export const SHIKI_MAX_CHARS = 500_000;

export interface ShikiRequest {
  id: number;
  lang: string;
  text: string;
}

export type ShikiResponse =
  | { id: number; ok: true; spans: Int32Array; styles: string[] }
  | { id: number; ok: false; error: string };
