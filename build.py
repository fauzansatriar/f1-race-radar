import argparse
import base64
import json
from hashlib import sha256
from pathlib import Path
from shutil import copytree

project = Path(__file__).resolve().parent
root = project / 'src'
static = root / 'static'
site = project / 'dist'
parser = argparse.ArgumentParser(description='Build the F1 Race Radar PWA.')
parser.add_argument('--standalone', action='store_true', help='Also write a single-file offline preview.')
args = parser.parse_args()
copytree(static, site, dirs_exist_ok=True)

fonts = root / 'fonts'
faces = (
    ('Formula One', 400, fonts / 'Formula1-Regular.ttf'),
    ('Formula One', 700, fonts / 'Formula1-Bold.ttf'),
    ('Formula One Black', 400, fonts / 'Formula1-Black.ttf'),
    ('Formula One Wide', 400, fonts / 'Formula1-Wide.ttf'),
)
codes = {
    'ALB':'alealb', 'ALO':'feralo', 'ANT':'andant', 'BEA':'olibea', 'BOR':'gabbor', 'BOT':'valbot',
    'CAM':'rafcam', 'COL':'fracol', 'GAS':'piegas', 'HAD':'isahad', 'HAM':'lewham', 'HIR':'ryohir',
    'HUL':'nichul', 'LAW':'lialaw', 'LEC':'chalec', 'LIN':'arvlin', 'NOR':'lannor', 'OCO':'estoco',
    'PER':'serper', 'PIA':'oscpia', 'RUS':'georus', 'SAI':'carsai', 'STR':'lanstr', 'TSU':'yuktsu',
    'VER':'maxver',
}

def asset(path, media_type):
    encoded = base64.b64encode(path.read_bytes()).decode('ascii')
    return f'data:{media_type};base64,{encoded}'

font_css = [
    f'@font-face {{ font-family: "{family}"; font-weight: {weight}; font-display: swap; '
    f'src: url({asset(file, "font/ttf")}) format("truetype"); }}'
    for family, weight, file in faces
]
portraits = {code: asset(root / 'portraits' / f'{key}.png', 'image/png') for code, key in codes.items()}
cache = json.loads((root / 'race-cache.json').read_text(encoding='utf-8'))
for driver in cache['participants'].values():
    for sample in driver['telemetry']:
        if sample[3] not in (0, 100):
            sample[3] = None
catalog = json.loads((root / 'season-catalog.json').read_text(encoding='utf-8'))
uncovered = {driver['driver'] for driver in cache['official']['standings']} - portraits.keys()
assert not uncovered, f'Missing official 2026 portraits: {uncovered}'
logo = asset((root / 'f1-logo.webp'), 'image/webp')
favicon = asset(root / 'favicon.png', 'image/png')
read = lambda name: (root / name).read_text(encoding='utf-8-sig')
def inline_json(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':')).replace('<', '\\u003c')

css = read('radar.css').replace('/*__FONT_FACES__*/', '\n'.join(font_css))
app = ('\n'.join(read(file) for file in (
    'radar-graphics.js', 'circuit-scene.js', 'race-pickers.js', 'public-timing.js', 'live-radar.js', 'radar.js',
))).replace('/*__PORTRAITS__*/ {}', inline_json(portraits))
app = app.replace('/*__RACE_CACHE__*/ {}', inline_json(cache))
app = app.replace('/*__CATALOG__*/ []', inline_json(catalog))
template = read('index.html').replace('/*__STYLES__*/', css).replace('/*__LOGO__*/', logo)
template = template.replace('/*__FAVICON__*/', favicon)
template = template.replace('/*__DATA__*/', read('race-data.js'))
car_files = sorted((site / 'assets' / 'cars').glob('*.webp'))
assert len(car_files) == 11

def make_html(cars, head='', menu='', install=''):
    return (template.replace('/*__APP__*/', app.replace('/*__TEAM_CARS__*/ {}', inline_json(cars)))
            .replace('<!--__PWA_HEAD__-->', head)
            .replace('<!--__PWA_MENU__-->', menu)
            .replace('<!--__PWA_INSTALL__-->', install))

if args.standalone:
    preview = project / 'F1 Race Radar.html'
    preview.write_text(make_html({p.stem: asset(p, 'image/webp') for p in car_files}), encoding='utf-8', newline='\n')
    print(preview)
head = """<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials">
  <link rel="apple-touch-icon" href="./assets/icon-180.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="F1 Race Radar">"""
menu = '<button class="sync-button install-button" type="button" id="install-pwa" hidden>Install app</button>'
install = """<dialog class="install-help" id="install-help" aria-labelledby="install-title">
    <h2 id="install-title">Install F1 Race Radar</h2>
    <p><strong>iPhone</strong> · In Safari, tap Share and choose Add to Home Screen. Turn on Open as Web App if prompted.</p>
    <p><strong>Android</strong> · In Chrome, open the browser menu and choose Install app or Add to Home screen.</p>
    <form method="dialog"><button class="sync-button">Done</button></form>
  </dialog>
  <script src="./pwa.js" defer></script>"""
(site / 'index.html').write_text(
    make_html({p.stem: './assets/cars/' + p.name for p in car_files}, head, menu, install), encoding='utf-8', newline='\n'
)
files = sorted([site / 'index.html', *(site / p.relative_to(static) for p in static.rglob('*') if p.is_file())])
routes = ['./'] + ['./' + p.relative_to(site).as_posix() for p in files]
fingerprint = sha256()
for path in files:
    fingerprint.update(path.relative_to(site).as_posix().encode('utf-8'))
    fingerprint.update(path.read_bytes())
worker = read('pwa-worker.js')
worker = worker.replace('/*__CACHE_VERSION__*/', fingerprint.hexdigest()[:16])
worker = worker.replace('/*__SHELL_ROUTES__*/ []', inline_json(routes))
(site / 'sw.js').write_text(worker, encoding='utf-8', newline='\n')
print(site / 'index.html', len(routes), 'cached URLs')
