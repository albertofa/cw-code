function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sandboxedPreviewDocument(name: string, html: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<title>${escapeAttribute(name)}</title>`,
    "<style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style>",
    `</head><body><iframe sandbox="allow-popups" srcdoc="${escapeAttribute(html)}"></iframe></body></html>`
  ].join("");
}
