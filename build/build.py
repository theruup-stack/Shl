# Bygger public/index.html från template + data.  Kör: python3 build/build.py
import os
from datetime import datetime, timezone
B = os.path.dirname(__file__)
r = lambda f: open(os.path.join(B, f), encoding='utf-8').read()
now = datetime(2026, 11, 22, 17, 0, tzinfo=timezone.utc)   # tidpunkt då videodatan hämtades
html = (r('template.html').replace('__DATA__', r('clubs_final.json')).replace('__PODS__', r('pods_final.json'))
        .replace('__SHL__', r('shl_final.json')).replace('__FIMPEN__', r('fimpen_final.json'))
        .replace('__GAMES__', r('games.json')).replace('__NOW__', str(int(now.timestamp() * 1000)))
        .replace('och sju hockeypoddars kanaler', 'och hockeypoddarnas kanaler'))
open(os.path.join(B, '..', 'public', 'index.html'), 'w', encoding='utf-8').write(html)
print('public/index.html', len(html))
