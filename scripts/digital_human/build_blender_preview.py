"""Build an editable single-character talking study without overwriting its source.

Run with Blender --background --disable-autoexec --python ... -- --source ...
The Windows speech fixture is an offline timing reference, not a character voice.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sys
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Quaternion, Vector

MOUTHS = ('あ', 'い', 'う', 'え', 'お')
CHANNELS = (*MOUTHS, 'まばたき', 'にこり', '口角上げ')
# Approximate English SAPI groups applied to observed Huihui events. Mandarin
# articulation is not linguistically validated. Energy remains the silence gate.
VISEME_MAP = {
    1: (0, .75), 2: (0, .85), 3: (4, .65), 4: (3, .8), 5: (3, .7),
    6: (1, .85), 7: (2, .8), 8: (4, .8), 9: (0, .75), 10: (4, .7),
    11: (0, .8), 12: (0, .25), 13: (2, .4), 14: (1, .4),
    15: (1, .45), 16: (2, .45), 17: (1, .4), 18: (1, .3),
    19: (1, .45), 20: (3, .45),
}


def write_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def clear_action(id_block):
    ad = id_block.animation_data
    if ad:
        ad.action = None
        for track in list(ad.nla_tracks):
            ad.nla_tracks.remove(track)


def curves(action):
    if hasattr(action, 'fcurves'):
        yield from action.fcurves
    else:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    yield from bag.fcurves


def evaluated_points(mesh):
    evaluated = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    coords = np.empty((len(evaluated.data.vertices), 3), dtype=np.float32)
    evaluated.data.vertices.foreach_get('co', coords.ravel())
    return coords


def driver_problems():
    bad, missing = [], []
    seen = set()

    def inspect(block):
        if not block or block.as_pointer() in seen:
            return
        seen.add(block.as_pointer())
        ad = block.animation_data
        if ad:
            for curve in ad.drivers:
                label = f'{block.name}:{curve.data_path}'
                if not curve.driver.is_valid:
                    bad.append(label)
                for var in curve.driver.variables:
                    for target in var.targets:
                        if target.id is None:
                            missing.append(label)
        if hasattr(block, 'nodes'):
            for node in block.nodes:
                if node.type == 'GROUP':
                    inspect(node.node_tree)

    for block in [*bpy.data.objects, *bpy.data.shape_keys, *bpy.data.node_groups]:
        inspect(block)
    for material in bpy.data.materials:
        if material.node_tree:
            inspect(material.node_tree)
    return {'invalid': bad, 'missing_targets': missing}


def freeze_mmd_coefficients():
    """Retain dynamic sliders; migrate plugin-only *coefficients* to native RNA.

    MMD group factors and UV scales are static authoring metadata. Unlike the
    placeholder shape values, their RNA paths vanish without the MMD addon.
    """
    blocks = [*bpy.data.objects, *bpy.data.shape_keys, *bpy.data.node_groups]
    blocks.extend(m.node_tree for m in bpy.data.materials if m.node_tree)
    seen, constants, converted = set(), {}, []
    for block in blocks:
        if block.as_pointer() in seen:
            continue
        seen.add(block.as_pointer())
        if not block.animation_data:
            continue
        for curve in block.animation_data.drivers:
            changed = False
            for variable in curve.driver.variables:
                for target in variable.targets:
                    path = target.data_path
                    if not path.startswith('mmd_root.'):
                        continue
                    assert (path.startswith('mmd_root.group_morphs[') and path.endswith('.factor')) or (
                        path.startswith('mmd_root.uv_morphs[') and path.endswith('.vertex_group_scale')), path
                    assert variable.type == 'SINGLE_PROP' and target.id is not None
                    value = float(target.id.path_resolve(path))
                    assert math.isfinite(value), path
                    identity = (target.id.as_pointer(), path)
                    if identity not in constants:
                        key = f'dh_source_coefficient_{len(constants):03d}'
                        target.id[key] = value
                        constants[identity] = key
                    key = constants[identity]
                    target.data_path = f'["{key}"]'
                    target.id.update_tag()
                    changed = True
                    converted.append({'owner': block.name, 'original_path': path,
                                      'native_path': target.data_path, 'value': value})
            if changed:
                # A driver that was invalid during initial depsgraph evaluation
                # stays disabled until its compiled expression is refreshed.
                curve.driver.expression = curve.driver.expression
                block.update_tag()
    bpy.context.scene.frame_set(bpy.context.scene.frame_current)
    bpy.context.view_layer.update()
    return converted


def remove_identity_driver_curves(shape_keys):
    """Remove only proven 1:1 remaps, whose 1e-4 key snapping loses small values.

    A driver needs no FCurve points for an identity transfer. Keep every driver
    expression and variable, and reject nonidentity or modified author curves.
    """
    removed = []
    for name in CHANNELS:
        path = shape_keys.key_blocks[name].path_from_id('value')
        curve = next(d for d in shape_keys.animation_data.drivers if d.data_path == path)
        if not curve.keyframe_points:
            continue
        assert len(curve.keyframe_points) == 2 and len(curve.modifiers) == 0, name
        assert curve.extrapolation == 'LINEAR', name
        points = list(curve.keyframe_points)
        for point, endpoint in zip(points, (0.0, 1.0)):
            assert abs(point.co.x - endpoint) < 1e-7 and abs(point.co.y - endpoint) < 1e-7, name
            for handle in (point.handle_left, point.handle_right):
                assert abs(handle.x - handle.y) < 1e-6, (name, list(handle))
        removed.append({'channel': name, 'mapping_before': [list(p.co) for p in points],
                        'expression_preserved': curve.driver.expression})
        curve.keyframe_points.clear()
        curve.driver.expression = curve.driver.expression
    shape_keys.update_tag()
    bpy.context.view_layer.update()
    return removed


def build(args):
    source = args.source.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source_hash = digest(source)
    # Only the builder uses MMD metadata. Saved output and playback require no
    # addon. Register the local source importer's property types if absent.
    if not hasattr(bpy.types.Object, 'mmd_root'):
        sys.path.insert(0, str(source.parent / 'tools'))
        import mmd_tools
        mmd_tools.register()
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
    scene = bpy.context.scene
    scene.frame_set(1)
    mesh = bpy.data.objects['AEMEATH_OFFICIAL_DISPLAY']
    rig = bpy.data.objects['AEMEATH_OFFICIAL_RIG']
    placeholder = bpy.data.objects['.placeholder']
    controls = placeholder.data.shape_keys.key_blocks
    display_keys = mesh.data.shape_keys.key_blocks
    baseline = evaluated_points(mesh)
    frozen_coefficients = freeze_mmd_coefficients()
    identity_remaps = remove_identity_driver_curves(mesh.data.shape_keys)
    assert float(np.max(np.abs(evaluated_points(mesh) - baseline))) == 0
    for obj in scene.objects:
        clear_action(obj)
        if obj.data and hasattr(obj.data, 'animation_data'):
            clear_action(obj.data)
    for keys in bpy.data.shape_keys:
        clear_action(keys)
    for name in CHANNELS:
        assert name in controls and name in display_keys, name
        controls[name].value = 0
    bpy.context.view_layer.update()
    neutral_error = float(np.max(np.abs(evaluated_points(mesh) - baseline)))
    assert neutral_error == 0, neutral_error

    scene.name = f'Aemeath_DigitalHuman_Speech_{args.version}'
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = args.resolution
    scene.render.resolution_y = args.resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = False
    if hasattr(scene, 'eevee') and hasattr(scene.eevee, 'taa_render_samples'):
        scene.eevee.taa_render_samples = 32
    scene.camera = bpy.data.objects['V9_Aemeath_front']
    scene.camera.data.ortho_scale = .36
    scene.camera.location.z = 1.46
    scene.render.fps = 30
    scene.render.fps_base = 1
    scene.render.use_sequencer = True
    scene.sync_mode = 'AUDIO_SYNC'
    scene.use_audio = True
    scene.use_audio_scrub = True

    # First inspect author-provided deformations individually, with no speech mix.
    atlas = []
    if args.render_atlas:
        atlas_dir = output / 'mouth_atlas'
        atlas_dir.mkdir(exist_ok=True)
        for label, weights in [
            ('00_neutral', {}), ('01_A', {'あ': .85}), ('02_I', {'い': .85}),
            ('03_U', {'う': .85}), ('04_E', {'え': .85}), ('05_O', {'お': .85}),
            ('06_M_candidate', {'M': .8}),
            ('07_smile_A', {'あ': .5, '口角上げ': .18, 'にこり': .12}),
            ('08_blink', {'まばたき': 1}),
        ]:
            for name in (*CHANNELS, 'M'):
                controls[name].value = weights.get(name, 0)
            bpy.context.view_layer.update()
            actual = {name: float(display_keys[name].value) for name in weights}
            assert all(abs(actual[n] - v) < 1e-6 for n, v in weights.items()), {
                'label': label, 'expected': weights, 'actual': actual, 'drivers': driver_problems()}
            scene.render.filepath = str(atlas_dir / (label + '.png'))
            start = time.monotonic()
            bpy.ops.render.render(write_still=True)
            atlas.append({'label': label, 'weights': weights, 'actual': actual,
                          'render_s': time.monotonic() - start})
            print('MOUTH_ATLAS', label, flush=True)
    for name in (*CHANNELS, 'M'):
        controls[name].value = 0
    bpy.context.view_layer.update()
    assert float(np.max(np.abs(evaluated_points(mesh) - baseline))) == 0

    audio_dir = output / 'audio'
    audio_dir.mkdir(exist_ok=True)
    for filename in ('speech_fixture.wav', 'speech_events.json', 'speech_envelope.json',
                     'speech_fixture.ssml', 'manifest.json'):
        shutil.copy2(args.speech / filename, audio_dir / filename)
    events = json.loads((audio_dir / 'speech_events.json').read_text(encoding='utf-8-sig'))
    envelope = json.loads((audio_dir / 'speech_envelope.json').read_text(encoding='utf-8-sig'))
    duration = float(envelope['duration_s'])
    raw = events['viseme_events']
    assert max(row['time_s'] + row['duration_s'] for row in raw) <= duration + .02
    event_times = np.array([row['time_s'] for row in raw])
    env_times = np.array([row['time_s'] for row in envelope['samples']])
    env_open = np.array([row['mouth_open'] for row in envelope['samples']])
    scene.frame_start = 1
    scene.frame_end = math.ceil((duration + .4) * 30) + 1
    head = rig.pose.bones['頭']
    head.rotation_mode = 'QUATERNION'
    rest_rotation = head.rotation_quaternion.copy()
    local_z = head.bone.matrix_local.to_3x3().inverted() @ Vector((0, 0, 1))
    local_x = head.bone.matrix_local.to_3x3().inverted() @ Vector((1, 0, 0))
    local_y = head.bone.matrix_local.to_3x3().inverted() @ Vector((0, 1, 0))
    # Small authored conversational beats; no claimed speech understanding/physics.
    beats = [(0, 0, 0, 0), (1.6, -2, 1.2, -.7), (3.5, 1, 0, .5),
             (4.7, 0, -1.2, 0), (6.8, 1.5, .5, -.5), (8.6, 0, 0, 0),
             (10.5, -1.3, 1.2, .6), (12.8, .8, -.4, 0), (duration, 0, 0, 0)]
    weights_smoothed = np.zeros(5)
    frame_controls = []
    for frame in range(scene.frame_start, scene.frame_end + 1):
        t = (frame - 1) / 30
        opening = float(np.interp(t, env_times, env_open, left=0, right=0))
        index = int(np.searchsorted(event_times, t, side='right') - 1)
        vid = raw[index]['viseme'] if index >= 0 and t <= duration else 0
        desired = np.zeros(5)
        if vid in VISEME_MAP and opening > .025:
            channel, strength = VISEME_MAP[vid]
            desired[channel] = strength * min(1, opening * 1.45)
        # Short crossfade, no overshoot or autonomous oscillator. Close immediately
        # when fixture envelope has ended; do not leave stale vowel weights alive.
        weights_smoothed += .65 * (desired - weights_smoothed)
        if opening < .015 or t > duration:
            weights_smoothed[:] = 0
        values = dict(zip(MOUTHS, weights_smoothed.tolist()))
        blink = max((max(0, 1 - abs(t - center) / .085) for center in (2.9, 6.1, 10.2, 13.8)), default=0)
        values.update({'まばたき': blink, 'にこり': .055, '口角上げ': .045})
        if t < .3 or t > duration:
            fade = min(1, max(0, t / .3)) if t < .3 else max(0, 1 - (t - duration) / .3)
            values['にこり'] *= fade
            values['口角上げ'] *= fade
        for name, value in values.items():
            controls[name].value = value
            controls[name].keyframe_insert('value', frame=frame)
        frame_controls.append({'frame': frame, 'time_s': t, 'viseme': vid,
                               'envelope': opening, 'weights': values})
    for t, yaw, pitch, roll in beats:
        head.rotation_quaternion = (rest_rotation @ Quaternion(local_z, math.radians(yaw))
                                    @ Quaternion(local_x, math.radians(pitch))
                                    @ Quaternion(local_y, math.radians(roll)))
        head.keyframe_insert('rotation_quaternion', frame=1 + t * 30)
    head.rotation_quaternion = rest_rotation
    head.keyframe_insert('rotation_quaternion', frame=scene.frame_end)
    for curve in curves(placeholder.data.shape_keys.animation_data.action):
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'
    for curve in curves(rig.animation_data.action):
        for point in curve.keyframe_points:
            point.handle_left_type = point.handle_right_type = 'AUTO_CLAMPED'
    placeholder.data.shape_keys.animation_data.action.name = f'Aemeath_AudioTimed_Mouth_Blink_{args.version}'
    rig.animation_data.action.name = f'Aemeath_Subtle_Head_Beats_{args.version}'

    if scene.sequence_editor:
        scene.sequence_editor_clear()
    editor = scene.sequence_editor_create()
    strips = editor.strips if hasattr(editor, 'strips') else editor.sequences
    sound_strip = strips.new_sound('Offline timing reference - Huihui', str(audio_dir / 'speech_fixture.wav'), channel=1, frame_start=1)
    sound_strip.volume = 1
    sound_strip.sound.pack()
    scene.timeline_markers.clear()
    for text, t in [('START / neutral', 0), ('Greeting', .45), ('Speech + pauses', 5),
                    ('Silence / mouth closes', duration)]:
        scene.timeline_markers.new(text, frame=round(1 + t * 30))
    scene['digital_human_version'] = f'{args.version} Blender offline speech study'
    scene['mouth_method'] = 'Recorded PCM envelope + approximate Windows SAPI viseme groups; not validated Mandarin phonemes'
    scene['speech_voice'] = 'Microsoft Huihui Desktop; fixture only, not final character voice'
    scene['source_sha256'] = source_hash
    scene['editing'] = 'Mouth keys: .placeholder / Shape Keys; head keys: AEMEATH_OFFICIAL_RIG; audio: Sequencer. Space plays timeline.'
    scene['scope'] = 'One Aemeath; original topology/materials/rig; no new cloth or hair physics; realtime app integration pending'
    notes = bpy.data.texts.new(f'README - Digital human {args.version}')
    notes.write(f'艾米斯数字人 {args.version} / Blender 口型预览\n\n空格播放，声音已打包。时间轴 30 fps，与 PCM 音频对齐。\n口型编辑：选择 .placeholder 的形态键；显示网格保留原驱动。\n头部动作：AEMEATH_OFFICIAL_RIG 的原生 Action。\n\n五元音来自原模型；SAPI viseme 只作近似分组，中文精准口型未验证。\n当前声音是 Windows 合成测试音，不是最终角色音色。\n这是离线工作样片，尚未接实时语音、打断、桌面 IPC。\nMMD 静态组合系数已转原生属性；无需插件播放，修改源组合系数后需重建。\n')

    # Store independent samples for fresh-process/fractional/reverse-seek checks.
    sample_frames = [1, 15.5, 30, 50.25, 88, 135.5, 177, 240.75, 300, 360.5, scene.frame_end]
    sample_frames = sorted(set(f for f in sample_frames if f <= scene.frame_end))
    reference = {'sample_frames': np.array(sample_frames), 'baseline': baseline}
    for i, frame in enumerate(sample_frames):
        scene.frame_set(int(frame), subframe=frame % 1)
        bpy.context.view_layer.update()
        reference[f'points_{i}'] = evaluated_points(mesh)
        reference[f'mouth_{i}'] = np.array([display_keys[name].value for name in CHANNELS])
    np.savez_compressed(output / 'reopen_reference.npz', **reference)
    problems = driver_problems()
    assert not problems['invalid'] and not problems['missing_targets'], problems
    scene.frame_set(1)
    assert np.max(np.abs(evaluated_points(mesh) - baseline)) == 0
    scene.frame_set(scene.frame_end)
    end_restore_error = float(np.max(np.abs(evaluated_points(mesh) - baseline)))
    assert end_restore_error < 1e-6, end_restore_error
    scene.frame_set(1)
    for obj in bpy.context.selected_objects:
        obj.select_set(False)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                space = area.spaces.active
                space.region_3d.view_perspective = 'CAMERA'
                space.overlay.show_overlays = False
                space.shading.type = 'MATERIAL'
                space.shading.use_scene_lights = True
                space.shading.use_scene_world = True
    blend = output / f'Aemeath_DigitalHuman_{args.version}.blend'
    assert blend != source
    sound_strip.sound.filepath = '//audio/speech_fixture.wav'
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), compress=False)
    assert digest(source) == source_hash
    report = {'source': str(source), 'source_sha256': source_hash, 'source_unchanged': True,
              'blend': str(blend), 'blender': bpy.app.version_string,
              'original_vertex_count': len(mesh.data.vertices), 'original_shape_count': len(display_keys),
              'neutral_restore_error_m': end_restore_error, 'driver_problems': problems,
              'plugin_coefficients_migrated': frozen_coefficients,
              'redundant_identity_driver_curves_removed': identity_remaps,
              'audio_duration_s': duration, 'fps': 30, 'frame_end': scene.frame_end,
              'packed_sound': bool(sound_strip.sound.packed_file),
              'atlas': atlas, 'reference_frames': sample_frames,
              'approximate_viseme_mapping': {str(k): {'shape': MOUTHS[v[0]], 'strength': v[1]} for k, v in VISEME_MAP.items()},
              'limitations': ['Offline synthetic speech only', 'Mandarin viseme identities approximate',
                              'No runtime microphone or interruption integration', 'No new cloth/hair physics']}
    write_json(output / 'build_report.json', report)
    write_json(output / 'mouth_timeline.json', frame_controls)
    print('BLENDER_PREVIEW_BUILT', json.dumps(report, ensure_ascii=False), flush=True)
    if args.render_frame:
        scene.frame_set(args.render_frame)
        scene.render.filepath = str(output / 'talking_preview.png')
        bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--speech', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resolution', type=int, default=640)
    parser.add_argument('--version', default='v03')
    parser.add_argument('--render-atlas', action='store_true')
    parser.add_argument('--render-frame', type=int, default=0)
    build(parser.parse_args(sys.argv[sys.argv.index('--') + 1:]))
