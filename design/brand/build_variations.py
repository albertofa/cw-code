"""Build vector logo options and a self-contained chooser. No existing assets change.
Requires fonttools, brotli, resvg-py, Pillow. Run: python design/brand/build_variations.py
"""
from pathlib import Path
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
import base64
import html
import json
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import resvg_py

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'variations'
OUT.mkdir(exist_ok=True)
fonts={w:instantiateVariableFont(TTFont(ROOT/'fonts/inter-latin-variable.woff2'),{'wght':w},inplace=True) for w in [400,500,600,700]}

def text(value,x,y,size,color='#dfe1e5',weight=600):
    f=fonts[weight]; glyphs=f.getGlyphSet(); cmap=f.getBestCmap(); scale=size/f['head'].unitsPerEm
    shapes=[]; cursor=0
    for char in value:
        glyph=glyphs[cmap[ord(char)]]; pen=SVGPathPen(glyphs); glyph.draw(pen)
        shapes.append(f'<path transform="translate({cursor},0)" d="{pen.getCommands()}"/>')
        cursor+=glyph.width-.02*size/scale
    return f'<g fill="{color}" transform="translate({x},{y}) scale({scale},{-scale})">'+''.join(shapes)+'</g>'

OPTIONS=[
 {'id':'a','name':'Angular CW','description':'The original direction. A square C beside an angular W.','strength':'Closest to the existing identity.','tradeoff':'The fine W loses definition at the smallest sizes.'},
 {'id':'b','name':'Lowercase cw','description':'A compact lowercase monogram drawn from Inter.','strength':'Direct, readable, and consistent with the app typography.','tradeoff':'A typographic mark has a more familiar silhouette.'},
 {'id':'c','name':'Console C','description':'A cut-corner C with a short command line inside it.','strength':'A bold silhouette with a clear coding reference.','tradeoff':'The C carries the name; the W is absent.'},
 {'id':'d','name':'Parallel','description':'Three paths converge into a shared workspace.','strength':'Represents the app’s parallel-session workflow.','tradeoff':'Abstract; needs the wordmark while the brand is new.'},
 {'id':'e','name':'Workspace','description':'A compact window with a project rail and two work panes.','strength':'Immediately describes a desktop workspace.','tradeoff':'More descriptive of the category than unique to cw-code.'},
 {'id':'f','name':'Folded W','description':'A heavy W built from a continuous angular ribbon.','strength':'Strong at small sizes and easy to recognize by shape.','tradeoff':'Emphasizes workspace rather than the full CW initials.'},
]

def mark(key,color):
    if key=='a': return f'<path d="M26 18H12V46H26 M31 18L36 46L43 32L50 46L55 18" fill="none" stroke="{color}" stroke-width="5"/>'
    if key=='b': return text('cw',7,44,36,color,700)
    if key=='c': return f'<path fill="{color}" d="M48 16H25L14 27V38L25 49H48V41H29L22 34V31L29 24H48Z"/><rect x="32" y="29" width="18" height="7" fill="{color}"/>'
    if key=='d': return f'<path d="M15 18H27L36 27H49 M15 32H49 M15 46H27L36 37H49" fill="none" stroke="{color}" stroke-width="5"/>'
    if key=='e': return f'<g fill="none" stroke="{color}" stroke-width="5"><rect x="14.5" y="17.5" width="35" height="29" rx="2"/><path d="M26 18V47 M27 32H49"/></g>'
    return f'<path fill="{color}" d="M10 19H18L25 39L32 24L39 39L46 19H54L42 47H36L32 38L28 47H22Z"/>'

def symbol(key,color,x=0,y=0,size=64):
    return f'<g transform="translate({x},{y}) scale({size/64})">{mark(key,color)}</g>'

def tile(key,treatment='violet',x=0,y=0,size=64):
    bg,fg={'violet':('#7c42ff','#ffffff'),'graphite':('#101214','#dfe1e5'),'light':('#dfe1e5','#101214')}[treatment]
    return f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{size*.21875}" fill="{bg}"/>'+symbol(key,fg,x,y,size)

def svg(w,h,body,title):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img"><title>{html.escape(title)}</title>{body}</svg>'

def png(source,width=None):
    content=resvg_py.svg_to_bytes(svg_string=source,width=width,skip_system_fonts=True)
    info=PngInfo();info.add_text('Description','Original cw-code vector logo exploration. Source: design/brand/build_variations.py. Typeface: bundled Inter (SIL OFL).')
    out=BytesIO();Image.open(BytesIO(content)).save(out,format='PNG',pnginfo=info);return out.getvalue()

def uri(content,mime): return 'data:'+mime+';base64,'+base64.b64encode(content).decode()
def img(content,alt,cls='',width=None):
    if isinstance(content,str): content=content.encode()
    return f'<img src="{uri(content,"image/svg+xml")}" alt="{html.escape(alt)}" class="{cls}"'+(f' width="{width}" height="{width}"' if width else '')+'>'

board='<rect width="1440" height="1420" fill="#1e1f22"/>'+text('cw-code / Logo directions',64,86,42)+text('Six options. Same palette. Same wordmark.',64,132,23,'#bcbec4',400)
rows=[]
for index,option in enumerate(OPTIONS):
    key=option['id']; folder=OUT/(key+'-'+option['name'].lower().replace(' ','-'));folder.mkdir(exist_ok=True)
    assets={}
    for treatment in ['violet','graphite','light']:
        source=svg(64,64,tile(key,treatment),option['name']+' app icon')
        assets[treatment]=source
        (folder/f'icon-{treatment}.svg').write_text(source,encoding='utf-8')
        for size in [16,24,32,48,64,256,512]: (folder/f'icon-{treatment}-{size}.png').write_bytes(png(source,size))
        Image.open(BytesIO(png(source,256))).save(folder/f'icon-{treatment}.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    for label,color in [('light','#dfe1e5'),('dark','#101214')]:
        source=svg(352,64,symbol(key,color)+text('cw-code',80,48,56,color),option['name']+' logo')
        assets['logo-'+label]=source
        (folder/f'logo-{label}.svg').write_text(source,encoding='utf-8')
        (folder/f'mark-{label}.svg').write_text(svg(64,64,mark(key,color),option['name']+' mark'),encoding='utf-8')
    (folder/'README.txt').write_text(f"cw-code / {option['name']}\nConcept for selection; not integrated into the app.\n\n{option['description']}\nStrength: {option['strength']}\nTradeoff: {option['tradeoff']}\n\nThree tile treatments, SVG/PNG/ICO, light and dark logos.\nLogo lettering is outlined Inter. Original geometry follows the repository license.\n",encoding='utf-8')
    (folder/'Inter-OFL.txt').write_bytes((ROOT/'fonts/inter-OFL.txt').read_bytes())
    archive=OUT/(folder.name+'.zip')
    with ZipFile(archive,'w',ZIP_DEFLATED) as z:
        for path in sorted(folder.iterdir()):z.write(path,path.name)
    # The summary sheet aligns all logos and samples, keeping scale consistent.
    x=64+(index%2)*688;y=190+(index//2)*395
    board+=text(key.upper()+' / '+option['name'],x,y+34,25)
    board+=tile(key,x=x,y=y+65,size=120)+symbol(key,'#dfe1e5',x+165,y+90,64)+text('cw-code',x+241,y+138,52)
    board+=text(option['description'].split('. ')[0],x,y+228,18,'#bcbec4',400)
    for n,size in enumerate([16,24,32,48,64]):board+=tile(key,x=x+n*83,y=y+258,size=size)
    board+=tile(key,'graphite',x+474,y+258,64)+tile(key,'light',x+558,y+258,64)
    treatment_controls=''.join(f'<label><input type="radio" name="treatment-{key}" value="{name}"'+(' checked' if name=='violet' else '')+f'><span>{name.title()}</span></label>' for name in ['violet','graphite','light'])
    preview_sets=''.join(f'<div class="preview-set" data-treatment="{treatment}"'+(' hidden' if treatment!='violet' else '')+'>'+img(source,option['name']+' '+treatment+' app icon','big-icon')+'<div class="scale-row">'+''.join('<figure>'+img(svg(64,64,tile(key,treatment),option['name']),f'{size}px icon',width=size)+f'<figcaption>{size}px</figcaption></figure>' for size in [16,24,32,48,64])+'</div></div>' for treatment,source in [(t,assets[t]) for t in ['violet','graphite','light']])
    rows.append(f'''<article id="option-{key}" data-key="{key}" data-name="{option['name']}">
    <div class="option-heading"><h2>{key.upper()} / {option['name']}</h2><button type="button" class="choose" aria-pressed="false">Choose {key.upper()}</button></div>
    <p class="description">{option['description']}</p><div class="samples"><div class="icon-column">{preview_sets}<fieldset><legend>Icon treatment</legend>{treatment_controls}</fieldset></div><div class="logo-column"><div class="logo-dark">{img(assets['logo-light'],option['name']+' light wordmark')}</div><div class="logo-light">{img(assets['logo-dark'],option['name']+' dark wordmark')}</div></div></div>
    <div class="reason"><p><strong>Why choose it</strong><br>{option['strength']}</p><p><strong>Tradeoff</strong><br>{option['tradeoff']}</p></div>
    <a class="download" href="{uri(archive.read_bytes(),'application/zip')}" download="{archive.name}">Download {key.upper()} assets · SVG, PNG, ICO</a></article>''')

(OUT/'comparison.svg').write_text(svg(1440,1420,board,'cw-code logo directions A to F'),encoding='utf-8')
(OUT/'comparison.png').write_bytes(png(svg(1440,1420,board,'cw-code logo directions A to F')))
css='''
:root{color-scheme:dark;--bg:#1e1f22;--text:#dfe1e5;--dim:#bcbec4;--line:#393b40}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 Inter,sans-serif}html{scroll-behavior:smooth;scroll-padding-top:90px}::selection{background:#214184}a{color:#b49cff;text-underline-offset:4px}a:hover{color:#fff}:focus-visible{outline:2px solid #548af7;outline-offset:4px}header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line)}nav{max-width:1280px;margin:auto;display:flex;gap:24px;align-items:center;padding:15px 32px}nav strong{margin-right:auto}nav a{color:var(--dim);text-decoration:none;font-size:14px}main{max-width:1280px;margin:auto;padding:0 40px}.intro{padding:68px 0 44px}h1{font-size:clamp(38px,5vw,64px);font-weight:500;line-height:1.1;letter-spacing:-.03em;margin:0 0 24px}.intro p{max-width:76ch;color:var(--dim)}.recommendation{font-size:15px}.comparison{width:100%;height:auto;margin-top:24px}summary{cursor:pointer;color:#b49cff;padding:14px 0}article{padding:52px 0 48px;border-top:1px solid var(--line)}.option-heading{display:flex;gap:20px;justify-content:space-between;align-items:center}h2{font-size:30px;font-weight:500;letter-spacing:-.02em;margin:0}button{font:500 14px Inter,sans-serif;color:var(--text);background:#2e3035;border:1px solid #62666e;border-radius:6px;padding:10px 18px;cursor:pointer}button:hover{background:#393b40}button[aria-pressed=true]{background:#7c42ff;border-color:#7c42ff;color:white}.description{color:var(--dim);margin:12px 0 28px}.samples{display:grid;grid-template-columns:1fr 1fr;gap:40px}.icon-column{background:#24262b;padding:32px;border-radius:12px}.preview-set:not([hidden]){display:flex;gap:32px;align-items:center;justify-content:space-around;min-height:176px}.big-icon{width:144px;height:144px}.scale-row{display:flex;gap:16px;align-items:center;flex-wrap:wrap;max-width:220px}figure{margin:0;text-align:center}figcaption{font-size:11px;color:var(--dim);margin-top:8px}.logo-column{display:grid;grid-template-rows:1fr 1fr;gap:16px}.logo-dark,.logo-light{display:flex;align-items:center;justify-content:center;padding:30px;border-radius:10px;background:#101214}.logo-light{background:#dfe1e5}.logo-column img{width:100%;max-width:340px;height:auto}fieldset{border:0;padding:0;margin:25px 0 0;display:flex;gap:20px;flex-wrap:wrap;font-size:13px}legend{font-size:12px;color:var(--dim);margin-bottom:10px}label{display:flex;align-items:center;gap:7px;cursor:pointer}input{accent-color:#7c42ff;width:16px;height:16px;margin:0}.reason{display:grid;grid-template-columns:1fr 1fr;gap:40px;color:var(--dim);font-size:14px;margin:15px 0}.reason strong{font-weight:500;color:var(--text)}.download{font-size:13px}.selection{position:sticky;bottom:0;padding:18px 32px;background:#101214;border-top:1px solid var(--line);display:flex;align-items:center;gap:24px;flex-wrap:wrap;z-index:3}.selection p{margin:0;flex:1;min-width:220px;font-size:14px}#feedback{font-size:12px;color:var(--dim)}footer{padding:32px 0 60px;color:var(--dim);font-size:13px}button:disabled{opacity:.45;cursor:default}
@media(max-width:900px){.samples{gap:20px}.preview-set:not([hidden]){flex-direction:column;gap:20px}.scale-row{max-width:none}.big-icon{width:128px;height:128px}.icon-column{padding:24px}}
@media(max-width:620px){nav{padding:14px 20px;gap:16px;flex-wrap:wrap}nav strong{font-size:14px;flex-basis:100%}main{padding:0 22px}.intro{padding-top:45px}h2{font-size:24px}.samples{grid-template-columns:1fr}.preview-set:not([hidden]){flex-direction:row;gap:24px}.big-icon{width:104px;height:104px}.scale-row{gap:12px}.logo-dark,.logo-light{min-height:110px;padding:24px}.reason{gap:20px}.selection{padding:15px 22px;gap:12px}.option-heading button{padding:8px 12px}article{padding-top:36px}fieldset{gap:16px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
'''
css="@font-face{font-family:Inter;src:url('"+uri((ROOT/'fonts/inter-latin-variable.woff2').read_bytes(),'font/woff2')+"') format('woff2');font-weight:100 900;font-display:swap}"+css
script='''
let selected=null;
const status=document.getElementById('selection-text'), copy=document.getElementById('copy-choice'), feedback=document.getElementById('feedback');
function update(){if(!selected)return;const treatment=selected.querySelector('input:checked').value;status.textContent=`Selected: ${selected.dataset.key.toUpperCase()} / ${selected.dataset.name} — ${treatment} icon`;copy.disabled=false;feedback.textContent='Selection stays on this page. Copy it to send in chat.';}
document.querySelectorAll('article').forEach(article=>{article.querySelector('.choose').addEventListener('click',()=>{selected=article;document.querySelectorAll('.choose').forEach(b=>b.setAttribute('aria-pressed','false'));article.querySelector('.choose').setAttribute('aria-pressed','true');update()});article.querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>{article.querySelectorAll('.preview-set').forEach(set=>set.hidden=set.dataset.treatment!==input.value);if(selected===article)update()}))});
copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(status.textContent);feedback.textContent='Copied. Paste this choice in chat.'}catch{const range=document.createRange();range.selectNodeContents(status);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);feedback.textContent='Text selected. Press Ctrl+C or Command+C, then paste in chat.'}});
'''
page='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cw-code — Choose a logo</title><style>'+css+'</style></head><body><header><nav><strong>cw-code / Logo options</strong>'+''.join(f'<a href="#option-{o["id"]}">{o["id"].upper()}</a>' for o in OPTIONS)+'</nav></header><main><section class="intro"><h1>Choose the mark.</h1><p>Six logo directions using the current graphite and violet palette. Compare the icon at real sizes, switch its treatment, and choose a direction. The Inter wordmark stays the same so the symbol is the main difference.</p><p class="recommendation">My shortlist: <strong>B / Lowercase cw</strong> for a simple name-led identity; <strong>F / Folded W</strong> for a stronger standalone icon.</p><details><summary>See all six side by side</summary>'+img(svg(1440,1420,board,'All six cw-code logo directions'),'Six logo directions compared','comparison')+'</details></section>'+''.join(rows)+'<footer>These are alternatives for review. The original branding suite and desktop app have not changed.<br>Each download contains all three icon treatments and both logo colors. Fonts and assets are embedded; this page works offline.</footer></main><div class="selection"><p id="selection-text" role="status" aria-live="polite">No selection yet. Choose A–F above.</p><button id="copy-choice" disabled>Copy choice</button><span id="feedback"></span></div><script>'+script+'</script></body></html>'
(OUT/'cw-code-logo-options.html').write_text(page,encoding='utf-8')
(OUT/'options.json').write_text(json.dumps(OPTIONS,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
(OUT/'README.md').write_text('# Logo variations\n\nOpen `cw-code-logo-options.html` for the self-contained chooser. `comparison.png` shows all six options. Each option folder and ZIP includes three icon treatments, seven PNG sizes per treatment, Windows ICO files, monochrome marks, outlined wordmarks, and a font license.\n\nStatus: Option C — Console C was selected. This folder preserves the comparison round; the updated canonical suite is in `../assets/` and `../cw-code-brand-review.html`. Desktop integration remains pending. The chooser stores selection only in page memory; use Copy choice to share it.\n\nRebuild: `python design/brand/build_variations.py`. Dependencies: fonttools, brotli, resvg-py, Pillow.\n',encoding='utf-8')
print(f'Generated six options, six ZIP kits, comparison.png, and {OUT / "cw-code-logo-options.html"}')
