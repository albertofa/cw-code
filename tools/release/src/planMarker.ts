const ANY_MARKER = /<!-- cw-release-plan sha=([0-9a-f]{40}) -->/;

export function planMarker(sourceSha: string): string {
  return `<!-- cw-release-plan sha=${sourceSha} -->`;
}

export function markedSourceSha(body: string | null | undefined): string | null {
  return ANY_MARKER.exec(body ?? "")?.[1] ?? null;
}

export function carriesPlanMarker(body: string | null | undefined, sourceSha: string): boolean {
  return markedSourceSha(body) === sourceSha;
}

export function releaseBody(notes: string, sourceSha: string): string {
  return `${notes.trimEnd()}\n\n${planMarker(sourceSha)}\n`;
}
