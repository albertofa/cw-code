export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const STATUS_LINE = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/;
const HEAD_TERMINATOR = /\r?\n\r?\n/;

export function parseGhIncludeOutput(stdout: string): HttpResponse | null {
  const text = stdout.replace(/^﻿/, "");
  const terminator = HEAD_TERMINATOR.exec(text);
  const head = terminator ? text.slice(0, terminator.index) : text;
  const body = terminator ? text.slice(terminator.index + terminator[0].length) : "";
  const [statusLine = "", ...headerLines] = head.split(/\r?\n/);
  const match = STATUS_LINE.exec(statusLine);
  if (!match) return null;
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { status: Number(match[1]), headers, body };
}
