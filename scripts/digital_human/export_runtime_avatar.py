"""Export v03 native mouth shapes for the interactive avatar, without saving Blender.

Run through Blender in a fresh background process. The original preview and the
previous six-shape GLB are read-only inputs. All MMD drivers/actions are removed
from the exported mesh in memory; glTF receives direct, initially neutral morphs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

import bpy
import numpy as np


KEEP = ('にこり', 'まばたき', '笑い', 'びっくり', 'あ', 'い', 'う', 'え', 'お', '口', '口角上げ', 'M')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def glb_read(path):
    blob = Path(path).read_bytes()
    magic, version, size = struct.unpack_from('<4sII', blob)
    assert magic == b'glTF' and version == 2 and size == len(blob)
    offset, document, binary = 12, None, None
    while offset < size:
        length, kind = struct.unpack_from('<II', blob, offset)
        chunk = blob[offset + 8: offset + 8 + length]
        if kind == 0x4E4F534A:
            document = json.loads(chunk)
        elif kind == 0x004E4942:
            binary = chunk
        offset += 8 + length
    assert offset == size and document and binary
    assert len(binary) >= document['buffers'][0]['byteLength']
    return document, binary


def accessor(document, binary, index):
    item = document['accessors'][index]
    dtype = {5120: 'i1', 5121: 'u1', 5122: '<i2', 5123: '<u2', 5125: '<u4', 5126: '<f4'}[item['componentType']]
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[item['type']]
    dtype = np.dtype(dtype)
    values = np.zeros((item['count'], width), dtype=dtype)
    if 'bufferView' in item:
        view = document['bufferViews'][item['bufferView']]
        start = view.get('byteOffset', 0) + item.get('byteOffset', 0)
        stride = view.get('byteStride', width * dtype.itemsize)
        assert start + (item['count'] - 1) * stride + width * dtype.itemsize <= len(binary)
        values = np.ndarray((item['count'], width), dtype=dtype, buffer=binary, offset=start,
                            strides=(stride, dtype.itemsize)).copy()
    if 'sparse' in item:
        sparse = item['sparse']
        index = sparse['indices']
        view = document['bufferViews'][index['bufferView']]
        start = view.get('byteOffset', 0) + index.get('byteOffset', 0)
        indices = np.frombuffer(binary, dtype={5121: 'u1', 5123: '<u2', 5125: '<u4'}[index['componentType']],
                                count=sparse['count'], offset=start)
        view = document['bufferViews'][sparse['values']['bufferView']]
        start = view.get('byteOffset', 0) + sparse['values'].get('byteOffset', 0)
        patches = np.frombuffer(binary, dtype=dtype, count=sparse['count'] * width,
                               offset=start).reshape((-1, width))
        assert np.all(indices < item['count'])
        values[indices] = patches
    return values


def image_hashes(document, binary):
    result = []
    for image in document.get('images', []):
        assert 'uri' not in image and 'bufferView' in image, 'Texture must be embedded'
        view = document['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        data = binary[start:start + view['byteLength']]
        assert len(data) == view['byteLength'] and len(data) > 0
        result.append(hashlib.sha256(data).hexdigest())
    return result


def verify_glb(path, previous):
    document, binary = glb_read(path)
    old, old_binary = glb_read(previous)
    assert len(document['meshes']) == 1 and len(document['skins']) == 1
    mesh = document['meshes'][0]
    names = mesh['extras']['targetNames']
    assert set(names) == set(KEEP), names
    assert len(mesh['weights']) == len(KEEP) and not any(mesh['weights'])
    assert not document.get('animations'), 'Offline speech animation must not ship'
    assert len(document['skins'][0]['joints']) == len(old['skins'][0]['joints']) == 987
    assert len(mesh['primitives']) == len(old['meshes'][0]['primitives']) == 44
    comparisons, max_weight_error = {}, 0.0
    morph_sizes = dict.fromkeys(names, 0.0)
    vertex_count = 0
    positions = []
    for new_primitive, old_primitive in zip(mesh['primitives'], old['meshes'][0]['primitives']):
        assert len(new_primitive['targets']) == len(names)
        for attr in ('POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'):
            new_values = accessor(document, binary, new_primitive['attributes'][attr])
            old_values = accessor(old, old_binary, old_primitive['attributes'][attr])
            assert new_values.shape == old_values.shape, attr
            error = float(np.max(np.abs(new_values.astype(float) - old_values.astype(float))))
            comparisons[attr] = max(comparisons.get(attr, 0.0), error)
            assert error == 0.0, (attr, error)
        indices = accessor(document, binary, new_primitive['indices'])
        assert np.array_equal(indices, accessor(old, old_binary, old_primitive['indices']))
        position = accessor(document, binary, new_primitive['attributes']['POSITION'])
        positions.append(position)
        vertex_count += len(position)
        assert int(indices.max()) < len(position)
        weights = accessor(document, binary, new_primitive['attributes']['WEIGHTS_0'])
        assert np.isfinite(weights).all() and weights.min() >= 0
        max_weight_error = max(max_weight_error, float(np.max(np.abs(weights.sum(axis=1) - 1))))
        joints = accessor(document, binary, new_primitive['attributes']['JOINTS_0'])
        assert joints.max() < 987
        for name, target in zip(names, new_primitive['targets']):
            delta = accessor(document, binary, target['POSITION'])
            assert delta.shape == position.shape and np.isfinite(delta).all()
            morph_sizes[name] = max(morph_sizes[name], float(np.linalg.norm(delta, axis=1).max()))
    assert all(morph_sizes[name] > 0 for name in KEEP), morph_sizes
    assert max_weight_error < 1e-5
    assert document['materials'] == old['materials'], 'Preserve existing runtime material settings'
    images = image_hashes(document, binary)
    assert images == image_hashes(old, old_binary), 'Preserve texture bytes and ordering'
    assert document['textures'] == old['textures']
    # Exported nodes retain the same coordinate system, bind matrices and pose.
    assert document['nodes'] == old['nodes'], 'Node transforms or hierarchy changed'
    assert np.array_equal(accessor(document, binary, document['skins'][0]['inverseBindMatrices']),
                          accessor(old, old_binary, old['skins'][0]['inverseBindMatrices']))
    bounds = np.vstack(positions)
    return {
        'file_bytes': path.stat().st_size, 'sha256': digest(path), 'target_names': names,
        'initial_weights': mesh['weights'], 'animations': 0, 'primitives': 44,
        'joints': 987, 'split_vertex_count': vertex_count,
        'bounds_y_up_min': bounds.min(axis=0).tolist(), 'bounds_y_up_max': bounds.max(axis=0).tolist(),
        'morph_max_delta_m': morph_sizes, 'max_skin_weight_sum_error': max_weight_error,
        'previous_attribute_max_error': comparisons, 'indices_equal_previous': True,
        'node_hierarchy_transforms_equal_previous': True, 'inverse_bind_matrices_equal_previous': True,
        'material_settings_equal_previous': True, 'embedded_images': len(images),
        'image_bytes_equal_previous': True,
    }


def build(args):
    source, output, previous = args.source.resolve(), args.output.resolve(), args.previous.resolve()
    source_hash, previous_hash = digest(source), digest(previous)
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    mesh = bpy.data.objects['AEMEATH_OFFICIAL_DISPLAY']
    rig = bpy.data.objects['AEMEATH_OFFICIAL_RIG']
    keys = mesh.data.shape_keys
    assert all(name in keys.key_blocks for name in KEEP)
    removed_drivers = len(keys.animation_data.drivers) if keys.animation_data else 0
    # Values in the preview are driven by .placeholder. glTF cannot transport
    # these dependencies, so preserve authored delta coordinates and expose the
    # mesh's own values directly. Neutral at frame 1 is the validated baseline.
    keys.animation_data_clear()
    rig.animation_data_clear()
    mesh.animation_data_clear()
    for block in keys.key_blocks:
        block.value = 0
    bpy.context.view_layer.objects.active = mesh
    for block in list(keys.key_blocks)[::-1]:
        if block.name not in ('Basis', *KEEP):
            mesh.shape_key_remove(block)
    assert all(block.relative_key == keys.key_blocks['Basis'] for block in keys.key_blocks[1:])
    bpy.context.view_layer.update()
    assert keys.animation_data is None
    # Same conversion as the existing desktop asset. Original Blender toon
    # materials remain untouched in the source .blend.
    for slot in mesh.material_slots:
        original = slot.material
        if not original:
            continue
        image = next((node.image for node in original.node_tree.nodes
                      if node.type == 'TEX_IMAGE' and node.name == 'mmd_base_tex' and node.image), None)
        if image is None:
            continue
        material = bpy.data.materials.new(original.name + '_RUNTIME')
        material.use_nodes = True
        material.diffuse_color = (1, 1, 1, max(0.0, min(1.0, original.diffuse_color[3])))
        nodes = material.node_tree.nodes
        nodes.clear()
        out = nodes.new('ShaderNodeOutputMaterial')
        bsdf = nodes.new('ShaderNodeBsdfPrincipled')
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = image
        bsdf.inputs['Roughness'].default_value = .82
        bsdf.inputs['Metallic'].default_value = 0
        material.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        alpha = nodes.new('ShaderNodeMath')
        alpha.operation = 'MULTIPLY'
        alpha.inputs[1].default_value = material.diffuse_color[3]
        material.node_tree.links.new(tex.outputs['Alpha'], alpha.inputs[0])
        material.node_tree.links.new(alpha.outputs[0], bsdf.inputs['Alpha'])
        material.node_tree.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        material.surface_render_method = 'DITHERED'
        slot.material = material
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True,
                              export_yup=True, export_animations=False, export_skins=True,
                              export_morph=True, export_morph_normal=False,
                              export_morph_tangent=False, export_materials='EXPORT',
                              export_image_format='AUTO')
    verification = verify_glb(output, previous)
    assert digest(source) == source_hash and digest(previous) == previous_hash
    report = {'source': str(source), 'source_sha256': source_hash, 'source_unchanged': True,
              'previous_runtime': str(previous), 'previous_runtime_sha256': previous_hash,
              'previous_runtime_unchanged': True, 'output': str(output),
              'blender': bpy.app.version_string, 'display_mmd_drivers_removed': removed_drivers,
              'exported_display_drivers': 0, 'verification': verification,
              'limitations': ['Direct native delta shapes, no phoneme recognition included',
                              'Runtime keeps the prior texture/PBR material conversion',
                              'No shape-normal or tangent deltas, matching prior runtime',
                              'No offline speech clip, audio or additional physics exported']}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('RUNTIME_AVATAR_EXPORT_VERIFIED', json.dumps(verification, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--previous', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    build(parser.parse_args(sys.argv[sys.argv.index('--') + 1:]))
