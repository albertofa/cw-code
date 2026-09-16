"""Build the standalone review HTML. Requires: python -m pip install markdown."""
from pathlib import Path
import base64
import html
import mimetypes
import re
import markdown

ROOT = Path(__file__).resolve().parent

def data(path):
    mime = {'.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown', '.py': 'text/plain'}.get(path.suffix) or mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    return f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode()

def image(name, alt, **attrs):
    extra = ' '.join(f'{key}="{html.escape(str(value))}"' for key, value in attrs.items())
    return f'<img src="{data(ROOT / name)}" alt="{html.escape(alt)}" {extra}>'

def download(path, label=None):
    return f'<a href="{data(path)}" download="{html.escape(path.name)}">{html.escape(label or path.name)}</a>'

documents = [('BRAND.md','guidelines'), ('COPY.md','copy'), ('SHIP.md','shipping'), ('LANDING-PAGE.md','landing'), ('README.md','handoff'), ('VALIDATION.md','validation')]
anchors = dict(documents)

def document(name, anchor):
    source = (ROOT / name).read_text(encoding='utf-8')
    # Keep a single page-level h1 while preserving every source document section.
    source = re.sub(r'^(#{1,5}) ', r'#\1 ', source, flags=re.M)
    rendered = markdown.markdown(source, extensions=['tables', 'fenced_code', 'sane_lists'])
    def link(match):
        target = html.unescape(match.group(1))
        if target in anchors:
            return f'href="#{anchors[target]}"'
        path = ROOT / target
        if path.is_file():
            return f'href="{data(path)}" download="{html.escape(path.name)}"'
        return match.group(0)
    rendered = re.sub(r'href="([^"]+)"', link, rendered)
    rendered = rendered.replace('<table>', '<div class="table-scroll" tabindex="0" role="region" aria-label="Reference table"><table>').replace('</table>', '</table></div>')
    rendered = rendered.replace('[x]', '<span class="task done" aria-label="Complete">✓</span>').replace('[ ]', '<span class="task" aria-label="Pending">□</span>')
    return f'<section id="{anchor}" class="document">{rendered}</section>'

style = '''
:root{color-scheme:dark;--bg:#1e1f22;--deep:#101214;--raised:#2e3035;--text:#dfe1e5;--dim:#bcbec4;--violet:#7c42ff;--line:#393b40}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:96px}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 Inter,sans-serif}::selection{background:#214184;color:#fff}a{color:#b49cff;text-underline-offset:4px}a:hover{color:#fff}button,a{touch-action:manipulation}:focus-visible{outline:2px solid #548af7;outline-offset:5px}body::-webkit-scrollbar{width:10px}body::-webkit-scrollbar-thumb{background:#62666e;border:2px solid var(--bg);border-radius:8px}
header{position:sticky;top:0;background:var(--bg);z-index:2;border-bottom:1px solid var(--line)}.bar{max-width:1328px;margin:auto;padding:16px 32px;display:flex;gap:32px;align-items:center}.brand{width:154px;height:28px;flex:none}.brand img{width:100%;height:100%}nav{display:flex;gap:22px;flex:1;flex-wrap:wrap}nav a{font-size:13px;color:var(--dim);text-decoration:none}button{border:1px solid var(--line);border-radius:6px;padding:8px 14px;color:var(--text);background:var(--raised);font:500 13px Inter,sans-serif;cursor:pointer}button:hover{background:#393b40}
main{max-width:1328px;margin:auto;padding:0 48px}section{padding:72px 0;border-bottom:1px solid var(--line)}.intro{padding:88px 0 64px}.intro h1{font-weight:500;font-size:clamp(40px,5.3vw,76px);line-height:1.1;letter-spacing:-.03em;max-width:1050px;margin:0 0 30px;text-wrap:balance}.intro .lead{font-size:clamp(18px,2vw,23px);color:var(--dim);max-width:800px}.status{color:var(--dim);font-size:13px;margin-top:28px}.intro .primary{width:min(352px,85%);height:auto;margin-bottom:44px}
h2{font-size:36px;line-height:1.2;font-weight:500;letter-spacing:-.025em;margin:0 0 28px}h3{font-size:24px;line-height:1.3;font-weight:600;margin:48px 0 18px;letter-spacing:-.02em}h4{font-size:19px;margin-top:32px}p,li{max-width:76ch}p{margin:14px 0 20px}li{margin-bottom:9px}ul,ol{padding-left:24px}.document>h2:not(:first-child){margin-top:48px}.document strong{font-weight:600}.document p,.document li{color:var(--dim)}.document strong{color:var(--text)}
.logo-layout{display:grid;grid-template-columns:1.55fr 1fr;gap:20px}.logo-stage{min-height:230px;display:flex;align-items:center;justify-content:center;border-radius:12px;background:var(--deep);padding:40px}.logo-stage img{width:100%;max-width:460px;height:auto}.logo-stage.light{background:#dfe1e5}.logo-stage.light img{max-width:320px}figure{margin:0}figcaption{font-size:13px;color:var(--dim);margin:14px 0 28px}.sizes{display:flex;gap:30px;align-items:end;flex-wrap:wrap;margin:36px 0}.size{display:flex;flex-direction:column;align-items:center;gap:14px}.size span{font:12px Mono,monospace;color:var(--dim)}.variants{display:flex;gap:24px;flex-wrap:wrap}.variants img{width:64px;height:64px}.variant-white{background:#101214;padding:20px;border-radius:8px}.variant-light{background:#dfe1e5;padding:20px;border-radius:8px}
.type-grid{display:grid;grid-template-columns:1fr 1fr;gap:64px}.type-name{font-size:42px;letter-spacing:-.02em;margin-bottom:4px}.specimen{font-size:clamp(22px,2.6vw,34px);overflow-wrap:anywhere}.mono{font-family:Mono,monospace}.muted{color:var(--dim)}.palette{display:grid;grid-template-columns:repeat(6,1fr);gap:18px;margin-top:52px}.swatch{height:82px;border:1px solid var(--line);border-radius:6px;margin-bottom:12px}.palette span{display:block;font-size:14px}.palette code{font-size:12px}.social{width:100%;height:auto;border-radius:10px}.visual-pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}.sheet{max-width:900px;width:100%;display:block;margin:24px auto}
code,pre{font-family:Mono,monospace;font-size:.87em}code{overflow-wrap:anywhere}pre{padding:24px;background:var(--deep);overflow:auto;border-radius:8px;line-height:1.7}pre code{overflow-wrap:normal}.table-scroll{overflow-x:auto;max-width:100%;margin:24px 0}table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.6;text-align:left}th{color:var(--text);font-weight:600;background:var(--deep)}td,th{padding:16px;vertical-align:top;border-bottom:1px solid var(--line)}td{color:var(--dim);min-width:140px}td:last-child{min-width:250px}.task{display:inline-block;color:var(--dim);min-width:22px}.done{color:#88d888}details{margin:24px 0}summary{cursor:pointer;font-weight:500;padding:14px 0;color:var(--text)}.downloads{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 32px;list-style:none;padding:0}.downloads li{padding:12px 0;border-bottom:1px solid var(--line);font-size:13px;overflow-wrap:anywhere}.copybox{background:var(--deep);padding:28px;border-radius:10px;margin-top:32px}.copybox p{font-size:20px;margin-top:0}.copybox button{margin-top:6px}#notice{min-height:24px;font-size:13px;color:var(--dim)}footer{max-width:1328px;padding:40px 48px 70px;margin:auto;font-size:13px;color:var(--dim)}
@media(max-width:800px){.bar{padding:14px 20px;gap:16px;flex-wrap:wrap}.bar nav{order:3;flex-basis:100%;gap:18px}.bar>button{margin-left:auto}main{padding:0 22px}section{padding:48px 0}.intro{padding-top:52px}.logo-layout,.type-grid,.visual-pair{grid-template-columns:1fr}.logo-stage{min-height:190px;padding:30px}.type-grid{gap:20px}.palette{grid-template-columns:repeat(3,1fr)}.downloads{grid-template-columns:1fr 1fr}h2{font-size:30px}footer{padding:32px 22px}html{scroll-padding-top:145px}}
@media(max-width:430px){.downloads{grid-template-columns:1fr}.sizes{gap:20px}nav a{font-size:12px}.palette{gap:12px}.copybox{padding:20px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{header,button,.downloads,#notice{display:none}body{background:#fff;color:#111;font-size:11px}main{padding:0;max-width:none}section{padding:24px 0;break-inside:auto}h2,h3{break-after:avoid}p,li,td,.document p,.document li,.muted,figcaption{color:#222}a{color:#432087}th,pre{background:#eee;color:#111}figure,.type-grid{break-inside:avoid}.intro h1{font-size:42px}.intro{padding:24px 0}.logo-stage,.palette,.social{-webkit-print-color-adjust:exact;print-color-adjust:exact}details>*{display:block}footer{padding:20px 0}}
'''
font_css = ''.join(f"@font-face{{font-family:{family};src:url('{data(ROOT/'fonts'/file)}') format('woff2');font-weight:100 900;font-display:swap}}" for family,file in [('Inter','inter-latin-variable.woff2'),('Mono','jetbrains-mono-latin-variable.woff2')])

parts = ['<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="cw-code branding suite: logo, typography, colors, copy, assets, and shipping plan."><title>cw-code — Brand review</title><link rel="icon" href="'+data(ROOT/'assets/app-icon.svg')+'"><style>'+font_css+style+'</style></head><body>']
parts += ['<header><div class="bar"><a class="brand" href="#overview" aria-label="cw-code brand overview">'+image('assets/lockup-primary.svg','cw-code')+'</a><nav aria-label="Brand review"><a href="#identity">Identity</a><a href="#guidelines">Guidelines</a><a href="#copy">Copy</a><a href="#shipping">Shipping plan</a><a href="#assets">Downloads</a></nav><button type="button" id="print">Print / PDF</button></div></header><main>']
parts += ['<section class="intro" id="overview">'+image('assets/lockup-primary.svg','cw-code',**{'class':'primary'})+'<h1>Your coding CLIs.<br>One desktop workspace.</h1><p class="lead">A desktop workspace for Claude Code, OpenCode, and Codex.</p><p class="status">Option C selected · Existing desktop palette and fonts · Desktop branding integrated; release pending</p><div class="copybox"><p id="description">cw-code is an open-source Windows desktop workspace for Claude Code, OpenCode, and Codex. Run sessions across projects, inspect files and Git diffs, and open real CLI terminals. It uses your installed CLIs and their authentication. Each CLI handles inference, model access, and session continuation.</p><button type="button" id="copy-description">Copy description</button><div id="notice" role="status" aria-live="polite"></div></div></section>']
parts += ['<section id="identity"><h2>Logo and app icon</h2><p class="muted">Selected: Option C — Console C, paired with a lowercase Inter wordmark. Violet for the app tile; single-color variants for other surfaces.</p><div class="logo-layout"><figure><div class="logo-stage">'+image('assets/lockup-primary.svg','Primary violet tile and light cw-code wordmark')+'</div><figcaption>Primary logo · Dark backgrounds</figcaption></figure><figure><div class="logo-stage light">'+image('assets/lockup-dark.svg','Dark monochrome cw-code logo')+'</div><figcaption>Single-color logo · Light backgrounds</figcaption></figure></div><div class="variants">'+''.join('<figure class="'+('variant-light' if name=='dark' else 'variant-white')+'">'+image(f'assets/mark-{name}.svg',f'{name} Console C mark')+'</figure>' for name in ['light','white','violet','dark'])+'</div><h3>At application sizes</h3><div class="sizes">'+''.join(f'<div class="size">'+image(f'assets/app-icon-{size}.png',f'{size} pixel app icon',width=size,height=size)+f'<span>{size}px</span></div>' for size in [16,20,22,24,32,40,48,64,128])+'</div><p class="muted">Windows ICO includes seven sizes from 16 to 256px. Installed taskbar appearance and display scaling remain release checks.</p></section>']
colors=[('Graphite','#1e1f22'),('Editor','#101214'),('Raised','#2e3035'),('Text','#dfe1e5'),('Violet','#7c42ff'),('Focus','#548af7')]
parts += ['<section id="type-color"><h2>Typography and color</h2><div class="type-grid"><div><p class="type-name">Inter</p><p class="muted">Headlines, navigation, descriptions.</p><p class="specimen">Aa Bb Cc 0123456789</p><p>Clear headings. Direct language.</p></div><div><p class="type-name mono">JetBrains Mono</p><p class="muted">Code, paths, commands, output.</p><p class="specimen mono">git diff --stat</p><p class="mono">src/main/index.ts</p></div></div><div class="palette">'+''.join(f'<div><div class="swatch" style="background:{color}"></div><span>{name}</span><code>{color}</code></div>' for name,color in colors)+'</div></section>']
parts += ['<section id="social"><h2>Social and repository images</h2><div class="visual-pair"><figure>'+image('assets/social.png','cw-code social preview: Your coding CLIs. One desktop workspace.',**{'class':'social','loading':'lazy'})+'<figcaption>Link preview · 1200 × 630</figcaption></figure><figure>'+image('assets/repository-social.png','cw-code repository social preview',**{'class':'social','loading':'lazy'})+'<figcaption>Repository preview · 1280 × 640</figcaption></figure></div><details><summary>View the complete visual brand sheet</summary>'+image('brand-sheet.png','Complete cw-code brand sheet with logos, typography, palette and icon sizes',**{'class':'sheet','loading':'lazy'})+'</details></section>']
parts += [document(name,anchor) for name,anchor in documents]
files = sorted(p for p in ROOT.rglob('*') if p.is_file() and (p.parent in [ROOT/'assets',ROOT/'fonts'] or p.parent == ROOT and p.name in ['tokens.json','generate.py','build_review.py','brand-sheet.png',*[d[0] for d in documents]]))
parts += ['<section id="assets"><h2>Download the assets</h2><p>Every file below is embedded in this HTML. Fonts, previews, documents, and downloads work offline. The SVG logos have outlined lettering.</p><ul class="downloads">'+''.join('<li>'+download(path)+'</li>' for path in files)+'</ul></section></main><footer>cw-code brand review · The complete suite, including source documents and downloadable assets.<br>Desktop branding is integrated; installer publication and the landing page remain pending. No external fonts, scripts, or image requests.</footer>']
parts += ['''<script>
document.getElementById('print').addEventListener('click',()=>{document.querySelectorAll('details').forEach(item=>item.open=true);window.print()});
document.getElementById('copy-description').addEventListener('click',async()=>{const source=document.getElementById('description');const notice=document.getElementById('notice');try{await navigator.clipboard.writeText(source.textContent);notice.textContent='Description copied.'}catch{const range=document.createRange();range.selectNodeContents(source);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);notice.textContent='Text selected. Press Ctrl+C (or Command+C) to copy.'}});
</script></body></html>''']
output=ROOT/'cw-code-brand-review.html'
output.write_text('\n'.join(parts),encoding='utf-8')
print(f'Created {output} ({output.stat().st_size:,} bytes; {len(files)} embedded downloads)')
