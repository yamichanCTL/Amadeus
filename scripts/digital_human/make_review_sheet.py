"""Arrange unmodified Blender renders and mouth detail crops for visual review."""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
args = parser.parse_args()
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 22)
small = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 17)
files = sorted((args.directory / 'mouth_atlas').glob('*.png'))
sheet = Image.new('RGB', (1080, 1440), '#111823')
draw = ImageDraw.Draw(sheet)
for i, path in enumerate(files):
    x, y = (i % 3) * 360, (i // 3) * 480
    src = Image.open(path).convert('RGB')
    sheet.paste(src.resize((348, 348), Image.Resampling.LANCZOS), (x + 6, y + 36))
    # Detail is a crop of the original raster; no face generation or retouching.
    detail = src.crop((265, 322, 377, 378)).resize((224, 112))
    sheet.paste(detail, (x + 67, y + 361))
    draw.text((x + 12, y + 8), path.stem[3:].replace('_', ' '), fill='#dbe5f5', font=font)
sheet.save(args.directory / 'mouth_contact_sheet.jpg', quality=94)
