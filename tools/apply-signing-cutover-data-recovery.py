from pathlib import Path

index=Path('index.html')
text=index.read_text(encoding='utf-8')
original=text
loader='  <script src="ghostlane-recovery.js"></script>\n  <script src="ghostlane-recovery-ui.js"></script>\n</body>'
if loader not in text:
    if '</body>' not in text: raise SystemExit('index.html: missing body close')
    text=text.replace('</body>',loader,1)
index.write_text(text,encoding='utf-8')

app=Path('app.js').read_text(encoding='utf-8')
required=["localStorage.getItem('ghostlane_ledger')","localStorage.setItem('ghostlane_ledger'","state.ledger.length > 50","localStorage.setItem('ghostlane_nodes'","localStorage.getItem('ghostlane_nodes')"]
for marker in required:
    if marker not in app: raise SystemExit(f'app.js storage contract marker missing: {marker}')
if 'ghostlane_nodes' in Path('ghostlane-recovery.js').read_text(encoding='utf-8'):
    raise SystemExit('Encrypted recovery must exclude the regeneratable ghostlane_nodes cache.')
radar=Path('radar.html').read_text(encoding='utf-8')
if 'src="/index.html?v=1.7.4"' not in radar:
    raise SystemExit('radar.html no longer embeds the expected v1.7.4 index surface')
if 'localStorage.clear(' in text or 'localStorage.clear(' in Path('ghostlane-recovery-ui.js').read_text(encoding='utf-8'):
    raise SystemExit('Destructive localStorage.clear() is forbidden')
print('index.html: '+('patched' if text!=original else 'already deterministic'))
