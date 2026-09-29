"""Read the Aemeath source asset without saving or changing the source file."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy
import numpy as np


def inspect(output: Path) -> None:
    mesh = bpy.data.objects['AEMEATH_OFFICIAL_DISPLAY']
    rig = bpy.data.objects['AEMEATH_OFFICIAL_RIG']
    basis = np.empty((len(mesh.data.vertices), 3), dtype=np.float32)
    mesh.data.shape_keys.key_blocks[0].data.foreach_get('co', basis.ravel())
    shapes = []
    for key in mesh.data.shape_keys.key_blocks:
        points = np.empty_like(basis)
        key.data.foreach_get('co', points.ravel())
        distances = np.linalg.norm(points - basis, axis=1)
        changed = distances > 1e-7
        shapes.append({
            'name': key.name, 'value': key.value,
            'relative_key': key.relative_key.name,
            'changed_vertices': int(changed.sum()),
            'max_delta': float(distances.max()),
            'bounds': [basis[changed].min(axis=0).tolist(), basis[changed].max(axis=0).tolist()] if changed.any() else None,
        })
    scene_rows = []
    for scene in bpy.data.scenes:
        scene_rows.append({
            'name': scene.name, 'camera': scene.camera.name if scene.camera else None,
            'objects': [o.name for o in scene.objects],
            'engine': scene.render.engine,
            'frame_start': scene.frame_start, 'frame_end': scene.frame_end,
            'fps': scene.render.fps,
        })
    report = {
        'source': bpy.data.filepath,
        'blender': bpy.app.version_string,
        'mesh': {'name': mesh.name, 'vertices': len(mesh.data.vertices),
                 'matrix_world': [list(row) for row in mesh.matrix_world],
                 'modifiers': [{'name': m.name, 'type': m.type} for m in mesh.modifiers]},
        'rig': {'name': rig.name, 'parent': rig.parent.name if rig.parent else None,
                'matrix_world': [list(row) for row in rig.matrix_world],
                'action': rig.animation_data.action.name if rig.animation_data and rig.animation_data.action else None,
                'bones': [{'name': b.name, 'head': list(b.head_local), 'tail': list(b.tail_local)} for b in rig.data.bones]},
        'shapes': shapes,
        'shape_drivers': [{'path': d.data_path, 'expression': d.driver.expression} for d in mesh.data.shape_keys.animation_data.drivers] if mesh.data.shape_keys.animation_data else [],
        'scenes': scene_rows,
        'cameras': [{'name': o.name, 'location': list(o.location), 'rotation': list(o.rotation_euler),
                     'type': o.data.type, 'lens': o.data.lens, 'ortho_scale': o.data.ortho_scale} for o in bpy.data.objects if o.type == 'CAMERA'],
        'lights': [{'name': o.name, 'type': o.data.type, 'energy': o.data.energy} for o in bpy.data.objects if o.type == 'LIGHT'],
        'materials': [{'name': m.name,
                       'drivers': [{'path': d.data_path, 'expression': d.driver.expression,
                                    'targets': [t.id.name if t.id else None for v in d.driver.variables for t in v.targets]} for d in m.node_tree.animation_data.drivers] if m.use_nodes and m.node_tree.animation_data else []} for m in mesh.data.materials],
        'images': [{'name': image.name, 'packed': bool(image.packed_file)} for image in bpy.data.images],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('ASSET_AUDIT', json.dumps({'output': str(output), 'shapes': len(shapes), 'scenes': len(scene_rows), 'bones': len(rig.data.bones)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    inspect(args.output)
