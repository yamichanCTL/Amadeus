"""Render the saved native timeline; leaves the editable blend unchanged."""
import argparse
import sys
from pathlib import Path

import bpy


parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--start', type=int, default=1)
parser.add_argument('--end', type=int)
parser.add_argument('--review-directory', type=Path)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
args.output.resolve().mkdir(parents=True, exist_ok=True)
scene = bpy.context.scene
scene.render.filepath = str(args.output.resolve() / 'frame_')
scene.render.image_settings.file_format = 'PNG'
scene.frame_start = args.start
if args.end:
    scene.frame_end = args.end
bpy.ops.render.render(animation=True)
if args.review_directory:
    review = args.review_directory.resolve()
    review.mkdir(parents=True, exist_ok=True)
    scene.camera = bpy.data.objects['V9_Aemeath_threequarter']
    scene.camera.data.ortho_scale = .36
    scene.camera.location.z = 1.46
    for frame in (1, 53, 88, 300):
        scene.frame_set(frame)
        scene.render.filepath = str(review / f'threequarter_{frame:04d}.png')
        bpy.ops.render.render(write_still=True)
