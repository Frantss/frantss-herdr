# Writes the site's page texture (frame.tsx) as one transparent SVG for both appearances:
# 0.75px dots every 8px, fading in from each edge (x: min(18rem, 20vw), y: 16rem). A layout
# background can't switch with the appearance, so the dots are a grey at 13% opacity over the
# theme's canvas: about #191919 on dark and #eaeaea on light (the site mixes #1c1c1c and #e8e8e8).
# The layout stretches the image to the window ("cover"), so it is drawn at the window's size, read
# from Herdr's window.json: run it again after resizing the window. Usage: texture.py <herdr-app home>
import json, sys
home = sys.argv[1]
w, h = (round(n) for n in json.load(open(f"{home}/window.json"))["bounds"][2:])
out = f"{home}/mods/frantss"
ex, ey = min(288, w * 0.2), 256
fade = lambda id, **a: f'<linearGradient id="{id}" ' + " ".join(f'{k}="{v}"' for k, v in a.items()) + '><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
open(f"{out}/texture.svg", "w").write(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
<defs>
<pattern id="d" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="0.75" fill="#808080" fill-opacity="0.13"/></pattern>
{fade("l", x1=0, x2=1)}{fade("r", x1=1, x2=0)}{fade("t", x2=0, y1=0, y2=1)}{fade("b", x2=0, y1=1, y2=0)}
<mask id="m"><rect width="{ex}" height="{h}" fill="url(#l)"/><rect x="{w-ex}" width="{ex}" height="{h}" fill="url(#r)"/><rect width="{w}" height="{ey}" fill="url(#t)"/><rect y="{h-ey}" width="{w}" height="{ey}" fill="url(#b)"/></mask>
</defs>
<rect width="{w}" height="{h}" fill="url(#d)" mask="url(#m)"/>
</svg>
''')
