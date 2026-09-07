#!/usr/bin/env python3
"""Real browser AEC signal test using isolated PulseAudio devices (no physical mic).

Prerequisites: Vite 5173, Electron, ffmpeg, Xvfb, PulseAudio, project Python env.
Output: .runtime/browser-aec/<timestamp>/ with PCM fixtures and numeric report.
The room simulator reads actual speaker playback, adds 80/94/113 ms reflections,
then mixes an independent near-end speaker after 10 s. No input frames are gated.
"""
from pathlib import Path
import os, sys, subprocess, time, signal, json
import numpy as np
from scipy.signal import correlate, resample_poly

ROOT = Path(__file__).resolve().parents[1]

def simulate_room():
    import subprocess,sys,os,wave
    import numpy as np
    from pathlib import Path
    root=Path(os.environ['AEC_TEST_DIR']);mode=sys.argv[2]
    with wave.open(str(root/'near.wav')) as w:near=np.frombuffer(w.readframes(w.getnframes()),'<i2').astype(float)/32768
    capture=subprocess.Popen(['parec','--device='+os.environ['AEC_TEST_SINK']+'.monitor','--rate=48000','--channels=1','--format=s16le','--latency-msec=10'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    play=subprocess.Popen(['pacat','--playback','--device='+os.environ['AEC_TEST_INPUT'],'--rate=48000','--channels=1','--format=s16le','--latency-msec=10'],stdin=subprocess.PIPE,stderr=subprocess.DEVNULL)
    old=np.zeros(6000);time=0;started=False
    try:
     with (root/('room-'+mode+'-near.pcm')).open('wb') as truth:
      while True:
       raw=capture.stdout.read(960)
       if len(raw)<960:break
       far=np.frombuffer(raw,'<i2').astype(float)/32768
       if not started and np.max(abs(far))>.01:started=True;time=0
       buf=np.r_[old,far];echo=sum(g*buf[len(old)-d:len(old)-d+480] for d,g in [(3840,.6),(4512,.18),(5424,.08)])
       user=np.zeros(480)
       if started:
        end=min(time+480,len(near));user[:max(0,end-time)]=near[time:end];time+=480
       output=(np.clip(echo+user,-1,1)*32767).astype('<i2').tobytes()
       truth.write((user*32767).astype('<i2').tobytes());play.stdin.write(output);play.stdin.flush();old=buf[-6000:]
    except (BrokenPipeError,KeyboardInterrupt):pass
    finally:capture.terminate();play.terminate();capture.wait();play.wait()

def generate_fixtures():
    from pathlib import Path
    import numpy as np, wave, subprocess
    root=Path(os.environ['AEC_TEST_DIR']);root.mkdir(exist_ok=True)
    rate=48000
    for name,text in [('far','This is the assistant speaking. Echo cancellation should remove this voice.'),('near','The user is speaking at the same time. Please keep my voice and continue listening.')]:
     p=root/(name+'-short.wav')
     subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','lavfi','-i',f'flite=text={text}:voice={"slt" if name == "far" else "kal"}','-ar',str(rate),str(p)],check=True)
     with wave.open(str(p)) as f: samples=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(float)/32768
     samples=samples*.35/max(abs(samples))
     seq=np.resize(np.r_[samples,np.zeros(rate//3)],22*rate)
     if name=='near': seq[:10*rate]=0
     globals()[name]=seq
     def write(name,x):
      with wave.open(str(root/name),'wb') as f:
       f.setparams((1,2,rate,0,'NONE',''));f.writeframes((np.clip(x,-1,1)*32767).astype('<i2').tobytes())
     write(name+'.wav',seq)
    echo=np.zeros_like(far)
    for delay,gain in [(80,.6),(94,.18),(113,.08)]:
     n=rate*delay//1000;echo[n:]+=far[:-n]*gain
    write('mic.wav',echo+near)

def analyze(out):
    results = {}
    for mode in ('off', 'on'):
        captured = np.fromfile(out / f'room-{mode}.pcm', '<i2').astype(float) / 32768
        near = resample_poly(np.fromfile(out / f'room-{mode}-near.pcm', '<i2').astype(float) / 32768, 1, 3)
        lag = int(np.argmax(abs(correlate(captured, near, 'full', method='fft'))) - len(near) + 1)
        onset = int(np.flatnonzero(abs(near) > .001)[0])
        echo = captured[onset + lag - 80000:onset + lag - 16000]
        gains, correlations = [], []
        # Account for independent device clocks with +/-50 ms local alignment.
        for start in range(onset + 16000, min(len(near), len(captured) - lag) - 16000, 16000):
            clean = near[start:start + 16000]
            segment = captured[start + lag - 800:start + lag + 16800]
            offset = int(np.argmax(abs(correlate(segment, clean, 'valid', method='fft'))))
            segment = segment[offset:offset + 16000]
            gains.append(float(np.dot(clean, segment) / np.dot(clean, clean)))
            correlations.append(float(np.dot(clean, segment) / (np.linalg.norm(clean) * np.linalg.norm(segment))))
        results[mode] = dict(samples=len(captured), echo_rms=float(np.sqrt(np.mean(echo ** 2))),
                             near_gain_median=float(np.median(gains)), near_correlation_median=float(np.median(correlations)))
    suppression = 20 * np.log10(results['off']['echo_rms'] / max(results['on']['echo_rms'], 1e-12))
    # These gates describe this simulated room, not a guarantee for arbitrary hardware.
    passed = bool(suppression >= 20 and results['on']['near_gain_median'] >= .25
                  and results['on']['near_correlation_median'] >= .6)
    report = dict(passed=passed, echo_suppression_db=float(suppression), measurements=results,
                  near_voice='kal', far_voice='slt', delays_ms=[80, 94, 113], gains=[.6, .18, .08],
                  note='Native AEC with continuous capture; simulated linear room, not physical-speaker certification.')
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    return report

def main():
    out = ROOT / '.runtime' / 'browser-aec' / str(time.time_ns())
    out.mkdir(parents=True)
    env = os.environ.copy()
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env.setdefault('PULSE_SERVER', 'unix:/mnt/wslg/runtime-dir/pulse/native')
    suffix = str(os.getpid())
    sink, mic_input, mic = ('asrapp_aec_test_' + suffix, 'asrapp_aec_input_' + suffix, 'asrapp_aec_mic_' + suffix)
    env.update(AEC_TEST_DIR=str(out), AEC_TEST_SINK=sink, AEC_TEST_INPUT=mic_input, AEC_TEST_MIC=mic, PULSE_SINK=sink)
    os.environ['AEC_TEST_DIR'] = str(out)
    generate_fixtures()
    modules = []
    def load(*args):
        modules.append(subprocess.check_output(['pactl', 'load-module', *args], env=env, text=True).strip())
    try:
        load('module-null-sink', 'sink_name=' + sink)
        load('module-null-sink', 'sink_name=' + mic_input, 'rate=48000', 'channels=1')
        load('module-remap-source', 'master=' + mic_input + '.monitor', 'source_name=' + mic,
             'source_properties=device.description=' + mic)
        for mode in ('off', 'on'):
            env['AEC_TEST_MODE'] = mode
            room = subprocess.Popen([sys.executable, __file__, '--room', mode], env=env, start_new_session=True)
            try:
                time.sleep(.5)
                subprocess.run(['xvfb-run', '-a', str(ROOT / 'frontend/desktop/node_modules/electron/dist/electron'),
                                '--no-sandbox', str(ROOT / 'scripts/test_browser_aec.cjs')], env=env, check=True)
            finally:
                os.killpg(room.pid, signal.SIGTERM)
                room.wait()
        report = analyze(out)
        print(json.dumps(dict(out=str(out), **report)))
        return 0 if report['passed'] else 1
    finally:
        for module in reversed(modules):
            subprocess.run(['pactl', 'unload-module', module], env=env, check=False)

if __name__ == '__main__':
    if '--room' in sys.argv:
        simulate_room()
    else:
        raise SystemExit(main())
