"""Independently verify the saved talking study without saving the blend.

Run in a new Blender process with --background --factory-startup --disable-autoexec.
The reference is from the builder; source geometry is separately compared to its
original blend. This verifies transport/timing, not Mandarin lip-sync accuracy.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import wave
from pathlib import Path

import bpy
import numpy as np

MOUTHS = ('あ', 'い', 'う', 'え', 'お')
CHANNELS = (*MOUTHS, 'まばたき', 'にこり', '口角上げ')


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def array_digest(collection, attribute, width, dtype=np.float32):
    value = np.empty(len(collection) * width, dtype=dtype)
    collection.foreach_get(attribute, value)
    return hashlib.sha256(value.tobytes()).hexdigest()


def signature(mesh):
    return {
        'vertices': len(mesh.data.vertices),
        'polygons': len(mesh.data.polygons),
        'basis_sha256': array_digest(mesh.data.vertices, 'co', 3),
        'loop_vertex_sha256': array_digest(mesh.data.loops, 'vertex_index', 1, np.int32),
        'polygon_material_sha256': array_digest(mesh.data.polygons, 'material_index', 1, np.int32),
        'uv_layers': {layer.name: array_digest(layer.data, 'uv', 2) for layer in mesh.data.uv_layers},
        'shape_keys': {key.name: array_digest(key.data, 'co', 3) for key in mesh.data.shape_keys.key_blocks},
        'material_names': [mat.name if mat else None for mat in mesh.data.materials],
    }


def evaluated_points(mesh):
    evaluated = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    points = np.empty((len(evaluated.data.vertices), 3), dtype=np.float32)
    evaluated.data.vertices.foreach_get('co', points.ravel())
    return points


def driver_report():
    seen = set()
    result = {'count': 0, 'invalid': [], 'missing_targets': [], 'unresolved_paths': [],
              'scripted_expressions': {}}

    def inspect(block):
        if not block or block.as_pointer() in seen:
            return
        seen.add(block.as_pointer())
        ad = getattr(block, 'animation_data', None)
        if ad:
            for curve in ad.drivers:
                label = f'{block.name}:{curve.data_path}'
                result['count'] += 1
                if not curve.driver.is_valid:
                    result['invalid'].append(label)
                if curve.driver.type == 'SCRIPTED':
                    expression = curve.driver.expression
                    result['scripted_expressions'][expression] = result['scripted_expressions'].get(expression, 0) + 1
                for variable in curve.driver.variables:
                    for target in variable.targets:
                        if target.id is None:
                            result['missing_targets'].append(label)
                        elif variable.type == 'SINGLE_PROP':
                            try:
                                target.id.path_resolve(target.data_path)
                            except (ValueError, KeyError):
                                result['unresolved_paths'].append(label + ':' + target.data_path)
        for node in getattr(block, 'nodes', ()):
            if node.type == 'GROUP':
                inspect(node.node_tree)

    for block in [*bpy.data.objects, *bpy.data.shape_keys, *bpy.data.node_groups]:
        inspect(block)
    for material in bpy.data.materials:
        inspect(material.node_tree)
    return result


def main(args):
    blend = args.blend.resolve()
    version = blend.stem.rsplit('_', 1)[-1]
    folder = blend.parent
    output = args.output.resolve() if args.output else folder / 'verification.json'
    build = json.loads((folder / 'build_report.json').read_text(encoding='utf-8'))
    timeline = json.loads((folder / 'mouth_timeline.json').read_text(encoding='utf-8'))
    envelope = json.loads((folder / 'audio/speech_envelope.json').read_text(encoding='utf-8-sig'))
    reference = np.load(folder / 'reopen_reference.npz')
    source = Path(build['source'])
    source_hash_before = digest(source)
    blend_hash_before = digest(blend)
    bpy.ops.wm.open_mainfile(filepath=str(blend), use_scripts=False)
    scene = bpy.context.scene
    mesh = bpy.data.objects['AEMEATH_OFFICIAL_DISPLAY']
    rig = bpy.data.objects['AEMEATH_OFFICIAL_RIG']
    placeholder = bpy.data.objects['.placeholder']
    controls = placeholder.data.shape_keys.key_blocks
    display = mesh.data.shape_keys.key_blocks
    result = {'status': 'running', 'blend': str(blend), 'blender': bpy.app.version_string,
              'fresh_process': True, 'autoexec_disabled': '--disable-autoexec' in sys.argv,
              'source': str(source), 'checks': {}, 'failures': [],
              'limits': ['No Mandarin phonetic accuracy or subjective synchronization claim',
                         'No realtime microphone, interruption, or app integration test',
                         'Control silence means vowel channels zero; a small smile remains in internal pauses']}

    def check(name, condition, evidence):
        result['checks'][name] = {'pass': bool(condition), 'evidence': evidence}
        if not condition:
            result['failures'].append(name)

    check('source_hash_matches_build', source_hash_before == build['source_sha256'], source_hash_before)
    check('disabled_autoexec', result['autoexec_disabled'], {'argv_flag': result['autoexec_disabled']})
    built_signature = signature(mesh)
    check('original_counts', len(display) == 149 and len(mesh.data.vertices) == 130108,
          {'vertices': len(mesh.data.vertices), 'shape_keys': len(display)})
    samples = reference['sample_frames'].tolist()
    sequence = samples + list(reversed(samples)) + [samples[4], samples[0], samples[4], samples[-1]]
    rows = []
    for frame in sequence:
        scene.frame_set(math.floor(frame), subframe=frame % 1)
        bpy.context.view_layer.update()
        index = samples.index(frame)
        points = evaluated_points(mesh)
        actual = np.array([display[name].value for name in CHANNELS])
        expected = reference[f'mouth_{index}']
        rows.append({'frame': frame, 'vertex_max_error_m': float(np.max(np.abs(points - reference[f'points_{index}']))),
                     'mouth_max_error': float(np.max(np.abs(actual - expected))),
                     'control_display_max_error': max(abs(controls[name].value - display[name].value) for name in CHANNELS),
                     'finite': bool(np.isfinite(points).all() and np.isfinite(actual).all())})
    check('fresh_reopen_all_reference_frames_reverse_repeat', len(samples) == 11 and all(
        row['finite'] and row['vertex_max_error_m'] <= 1e-7 and row['mouth_max_error'] <= 1e-7
        and row['control_display_max_error'] <= 1e-6 for row in rows), rows)

    fps = scene.render.fps / scene.render.fps_base
    timeline_errors = []
    control_differences = []
    all_control_error = 0.0
    envelope_error = 0.0
    silent_frames = []
    env_times = [row['time_s'] for row in envelope['samples']]
    env_values = [row['mouth_open'] for row in envelope['samples']]
    for row in timeline:
        frame, seconds = row['frame'], row['time_s']
        if abs(seconds - (frame - scene.frame_start) / fps) > 1e-12:
            timeline_errors.append(frame)
        envelope_error = max(envelope_error, abs(row['envelope'] - float(np.interp(seconds, env_times, env_values, left=0, right=0))))
        scene.frame_set(frame)
        for name, expected in row['weights'].items():
            all_control_error = max(all_control_error, abs(controls[name].value - expected),
                                    abs(display[name].value - expected))
            if max(abs(controls[name].value - expected), abs(display[name].value - expected)) > 1e-6:
                control_differences.append({'frame': frame, 'channel': name, 'expected': expected,
                                           'control': controls[name].value, 'display': display[name].value})
        if row['envelope'] < .015 or seconds > envelope['duration_s']:
            silent_frames.append({'frame': frame, 'max_vowel_value': max(abs(display[name].value) for name in MOUTHS)})
    check('timeline_timebase_and_native_actions', fps == 30 and len(timeline) == scene.frame_end - scene.frame_start + 1
          and [row['frame'] for row in timeline] == list(range(scene.frame_start, scene.frame_end + 1))
          and not timeline_errors and all_control_error <= 1e-6 and envelope_error <= 1e-12,
          {'fps': fps, 'rows': len(timeline), 'frame_start': scene.frame_start, 'frame_end': scene.frame_end,
           'invalid_timebase_frames': timeline_errors, 'all_frame_control_max_error': all_control_error,
           'interpolated_envelope_max_error': envelope_error, 'control_differences_above_1e_minus6': control_differences})
    check('silence_closes_vowel_controls', bool(silent_frames) and max(row['max_vowel_value'] for row in silent_frames) == 0,
          {'silent_frame_count': len(silent_frames), 'max_vowel_value': max(row['max_vowel_value'] for row in silent_frames)})
    boundary_errors = []
    for frame in (scene.frame_start, scene.frame_end):
        scene.frame_set(frame)
        boundary_errors.append({'frame': frame, 'neutral_vertex_max_error_m': float(np.max(np.abs(evaluated_points(mesh) - reference['baseline'])))})
    check('neutral_start_and_end', all(row['neutral_vertex_max_error_m'] <= 1e-7 for row in boundary_errors), boundary_errors)

    drivers = driver_report()
    check('drivers_valid_with_resolvable_targets', not drivers['invalid'] and not drivers['missing_targets']
          and not drivers['unresolved_paths'], drivers)
    handlers = {name: [f'{fn.__module__}.{fn.__name__}' for fn in getattr(bpy.app.handlers, name)]
                for name in ('frame_change_pre', 'frame_change_post', 'depsgraph_update_pre', 'depsgraph_update_post')}
    actions = {'mouth_action': placeholder.data.shape_keys.animation_data.action.name,
               'rig_action': rig.animation_data.action.name,
               'key_light_action': None if not bpy.data.objects['V9 Aemeath Key'].animation_data else
                   getattr(bpy.data.objects['V9 Aemeath Key'].animation_data.action, 'name', None),
               'enabled_embedded_scripts': [text.name for text in bpy.data.texts if text.use_module],
               'handlers': handlers}
    check('native_actions_without_frame_handlers', actions['mouth_action'] == f'Aemeath_AudioTimed_Mouth_Blink_{version}'
          and actions['rig_action'] == f'Aemeath_Subtle_Head_Beats_{version}' and actions['key_light_action'] is None
          and not actions['enabled_embedded_scripts'] and all(not rows for rows in handlers.values()), actions)

    image_rows = [{'name': image.name, 'packed': bool(image.packed_file), 'size': list(image.size)}
                  for image in bpy.data.images if image.source == 'FILE']
    check('images_packed', bool(image_rows) and all(row['packed'] for row in image_rows), image_rows)
    strips = scene.sequence_editor.strips if hasattr(scene.sequence_editor, 'strips') else scene.sequence_editor.sequences
    sounds = [strip for strip in strips if strip.type == 'SOUND']
    with wave.open(str(folder / 'audio/speech_fixture.wav'), 'rb') as wav:
        wav_seconds = wav.getnframes() / wav.getframerate()
    audio_rows = [{'name': strip.name, 'packed': bool(strip.sound.packed_file), 'path': strip.sound.filepath,
                   'frame_start': strip.frame_start, 'frame_offset_start': strip.frame_offset_start,
                   'frame_final_start': strip.frame_final_start, 'frame_final_duration': strip.frame_final_duration,
                   'mute': strip.mute, 'volume': strip.volume} for strip in sounds]
    check('audio_packed_and_zero_offset_timebase', len(sounds) == 1 and all(
        row['packed'] and row['frame_start'] == 1 and row['frame_offset_start'] == 0 and not row['mute']
        and row['volume'] > 0 and abs(row['frame_final_duration'] / fps - wav_seconds) <= 1 / fps for row in audio_rows)
        and abs(wav_seconds - envelope['duration_s']) <= 1e-8 and scene.sync_mode == 'AUDIO_SYNC',
        {'audio': audio_rows, 'wav_seconds': wav_seconds, 'envelope_seconds': envelope['duration_s'],
         'sync_mode': scene.sync_mode})

    # A separate source load checks all original morph coordinates, topology and
    # UVs. No geometry is copied from the builder's reference for this comparison.
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
    original_signature = signature(bpy.data.objects['AEMEATH_OFFICIAL_DISPLAY'])
    mismatch = [key for key in original_signature if original_signature[key] != built_signature[key]]
    check('source_geometry_uv_all_149_shapes_material_slots_preserved', not mismatch,
          {'mismatched_fields': mismatch, 'shape_count': len(original_signature['shape_keys']),
           'vertex_count': original_signature['vertices'], 'material_count': len(original_signature['material_names'])})
    check('files_not_modified_by_verification', digest(source) == source_hash_before and digest(blend) == blend_hash_before,
          {'source_sha256': source_hash_before, 'preview_sha256': blend_hash_before})
    result['status'] = 'pass' if not result['failures'] else 'fail'
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print('INDEPENDENT_VERIFICATION', result['status'], 'failures=', result['failures'], 'report=', str(output), flush=True)
    if result['failures']:
        raise RuntimeError('Verification failures: ' + ', '.join(result['failures']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--blend', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    main(parser.parse_args(sys.argv[sys.argv.index('--') + 1:]))
