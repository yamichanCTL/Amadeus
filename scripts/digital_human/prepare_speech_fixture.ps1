[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../.runtime/digital_human_v1/speech'),
    [string]$Voice = 'Microsoft Huihui Desktop',
    [ValidateRange(-10, 10)][int]$Rate = 1
)

$ErrorActionPreference = 'Stop'
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
Add-Type -AssemblyName System.Speech

# C# event handlers run independently of the PowerShell runspace. Registering a
# PowerShell script-block handler while SpeakSsml blocks can lose event delivery.
if (-not ('AmadeusFixture.LocalSpeechFixture' -as [type])) {
    $speechReferences = @([System.Speech.Synthesis.SpeechSynthesizer].Assembly.Location)
    if ($PSVersionTable.PSEdition -eq 'Core') {
        $speechReferences += Join-Path $PSHOME 'ref/System.Collections.dll'
        $speechReferences += Join-Path $PSHOME 'ref/System.Threading.dll'
    }
    Add-Type -ReferencedAssemblies $speechReferences -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;

namespace AmadeusFixture {
    public sealed class VisemeRecord {
        public double time_s, duration_s;
        public int viseme, next_viseme, emphasis;
    }
    public sealed class WordRecord {
        public double time_s;
        public int character_position, character_count;
        public string text;
    }
    public sealed class BookmarkRecord {
        public double time_s;
        public string name;
    }
    public sealed class EnvelopeRecord {
        public double time_s, rms, peak, mouth_open;
    }
    public sealed class SpeechResult {
        public List<VisemeRecord> visemes = new List<VisemeRecord>();
        public List<WordRecord> words = new List<WordRecord>();
        public List<BookmarkRecord> bookmarks = new List<BookmarkRecord>();
        public List<EnvelopeRecord> envelope = new List<EnvelopeRecord>();
        public int sample_rate, channels, bits_per_sample, sample_count;
        public double duration_s, normalization_rms;
    }
    public static class LocalSpeechFixture {
        public static SpeechResult Generate(string path, string voice, int rate, string ssml) {
            var r = new SpeechResult();
            using (var synth = new SpeechSynthesizer()) {
                synth.SelectVoice(voice);
                synth.Rate = rate;
                synth.VisemeReached += delegate(object sender, VisemeReachedEventArgs e) {
                    lock(r.visemes) r.visemes.Add(new VisemeRecord {
                        time_s = e.AudioPosition.TotalSeconds,
                        duration_s = e.Duration.TotalSeconds,
                        viseme = e.Viseme, next_viseme = e.NextViseme, emphasis = (int)e.Emphasis
                    });
                };
                synth.SpeakProgress += delegate(object sender, SpeakProgressEventArgs e) {
                    lock(r.words) r.words.Add(new WordRecord {
                        time_s = e.AudioPosition.TotalSeconds, text = e.Text,
                        character_position = e.CharacterPosition, character_count = e.CharacterCount
                    });
                };
                synth.BookmarkReached += delegate(object sender, BookmarkReachedEventArgs e) {
                    lock(r.bookmarks) r.bookmarks.Add(new BookmarkRecord {
                        time_s = e.AudioPosition.TotalSeconds, name = e.Bookmark
                    });
                };
                // Huihui at requested 22050 Hz emitted event timestamps beyond
                // the WAV duration. 16000 Hz was independently checked against
                // the RIFF sample count and final event; do not scale raw events.
                synth.SetOutputToWaveFile(path,
                    new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
                synth.SpeakSsml(ssml);
                synth.SetOutputToNull();
            }
            ReadEnvelope(path, r);
            return r;
        }
        private static void ReadEnvelope(string path, SpeechResult r) {
            byte[] data = null;
            using (var file = File.OpenRead(path))
            using (var reader = new BinaryReader(file)) {
                if (new string(reader.ReadChars(4)) != "RIFF") throw new Exception("Not a RIFF WAV");
                reader.ReadUInt32();
                if (new string(reader.ReadChars(4)) != "WAVE") throw new Exception("Not WAVE");
                while(file.Position + 8 <= file.Length) {
                    string id = new string(reader.ReadChars(4));
                    int size = reader.ReadInt32();
                    long next = file.Position + size + (size % 2);
                    if (id == "fmt ") {
                        if(reader.ReadInt16() != 1) throw new Exception("Expected PCM WAV");
                        r.channels = reader.ReadInt16(); r.sample_rate = reader.ReadInt32();
                        reader.ReadInt32(); reader.ReadInt16(); r.bits_per_sample = reader.ReadInt16();
                    } else if(id == "data") { data = reader.ReadBytes(size); }
                    file.Position = next;
                }
            }
            if(data == null || r.channels != 1 || r.bits_per_sample != 16)
                throw new Exception("Expected mono 16-bit PCM audio");
            r.sample_count = data.Length / 2;
            r.duration_s = (double)r.sample_count / r.sample_rate;
            // 120 Hz sample times, centred 20 ms measurement windows. This is
            // acoustic amplitude, not inferred phoneme alignment.
            int halfWindow = (int)(r.sample_rate * 0.010);
            int pointCount = (int)Math.Ceiling(r.duration_s * 120.0) + 1;
            var levels = new List<double>();
            for(int i = 0; i < pointCount; i++) {
                double t = Math.Min((double)i / 120.0, r.duration_s);
                int centre = (int)Math.Round(t * r.sample_rate);
                int start = Math.Max(0, centre - halfWindow);
                int end = Math.Min(r.sample_count, centre + halfWindow);
                double sum = 0, peak = 0;
                for(int j = start; j < end; j++) {
                    double value = BitConverter.ToInt16(data, j * 2) / 32768.0;
                    sum += value * value; peak = Math.Max(peak, Math.Abs(value));
                }
                double rms = end > start ? Math.Sqrt(sum / (end - start)) : 0;
                r.envelope.Add(new EnvelopeRecord { time_s = t, rms = rms, peak = peak });
                if(rms > 0.004) levels.Add(rms);
            }
            levels.Sort();
            r.normalization_rms = levels.Count > 0 ? levels[(int)((levels.Count - 1) * 0.95)] : 1;
            double previous = 0;
            foreach(var e in r.envelope) {
                double target = e.rms < 0.004 ? 0 : Math.Min(1, Math.Sqrt(e.rms / r.normalization_rms));
                double tau = target > previous ? 0.018 : 0.045;
                previous += (target - previous) * (1 - Math.Exp(-1.0 / 120.0 / tau));
                e.mouth_open = previous < 0.015 ? 0 : previous;
            }
            // The clip includes final silence. Anchor exact neutral at its end.
            if(r.envelope.Count > 0) r.envelope[r.envelope.Count - 1].mouth_open = 0;
        }
    }
}
'@
}

$ssml = @'
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">
  <break time="350ms"/>
  <mark name="greeting_start"/>你好，我是艾米斯。很高兴见到你。
  <mark name="greeting_end"/><break time="850ms"/>
  <mark name="explanation_start"/>现在我会跟着声音说话。停一下，<break time="650ms"/>再继续。我们慢慢把这些动作做好。
  <mark name="explanation_end"/><break time="600ms"/>
</speak>
'@
$wavPath = Join-Path $outputRoot 'speech_fixture.wav'
$result = [AmadeusFixture.LocalSpeechFixture]::Generate($wavPath, $Voice, $Rate, $ssml)
$nonzeroVisemeCount = @($result.visemes | Where-Object viseme -ne 0).Count
$visemeObserved = $nonzeroVisemeCount -gt 0
$maxEventEnd = ($result.visemes | ForEach-Object { $_.time_s + $_.duration_s } | Measure-Object -Maximum).Maximum
$eventTimeRangeValid = ($null -ne $maxEventEnd) -and ($maxEventEnd -le $result.duration_s + 0.020)

$raw = [ordered]@{
    schema_version = 1
    voice = $Voice
    language = 'zh-CN'
    time_unit = 'seconds'
    duration_s = $result.duration_s
    source = 'Local Windows System.Speech; synthetic demonstration, not the final character voice.'
    nonzero_visemes_observed = $visemeObserved
    event_times_within_audio = $eventTimeRangeValid
    maximum_event_end_s = $maxEventEnd
    viseme_events = @($result.visemes)
    word_events = @($result.words)
    bookmarks = @($result.bookmarks)
    mapping_reference = 'https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.visemereached?view=netframework-4.8.1'
    mapping_caveat = 'The System.Speech 0..21 table is documented for US English, not a guaranteed Mandarin phoneme map. Raw events must be validated for this installed Chinese voice.'
    bookmark_caveat = 'Bookmarks are unmodified engine notifications. The initial bookmark can be at 0 even with leading silence; use acoustic measurements for speech onset.'
}
$envelope = [ordered]@{
    schema_version = 1
    audio_file = 'speech_fixture.wav'
    time_unit = 'seconds'
    duration_s = $result.duration_s
    track_sample_rate_hz = 120
    measurement_window_s = 0.020
    silence_rms_threshold = 0.004
    normalization_rms = $result.normalization_rms
    attack_s = 0.018
    release_s = 0.045
    semantics = 'mouth_open is a smoothed audio-amplitude preview control in 0..1, not a phoneme or linguistic viseme. Sample/interpolate by audio time; never run on a free-running animation clock.'
    samples = @($result.envelope)
}
$manifest = [ordered]@{
    schema_version = 1
    generated_at = [DateTimeOffset]::Now.ToString('o')
    generator = 'scripts/digital_human/prepare_speech_fixture.ps1'
    voice = $Voice
    voice_rate = $Rate
    is_synthetic_demo = $true
    final_voice = $false
    texts = @('你好，我是艾米斯。很高兴见到你。', '现在我会跟着声音说话。停一下，再继续。我们慢慢把这些动作做好。')
    audio = [ordered]@{ file = 'speech_fixture.wav'; sample_rate = $result.sample_rate; channels = $result.channels; bits_per_sample = $result.bits_per_sample; sample_count = $result.sample_count; duration_s = $result.duration_s; sha256 = (Get-FileHash -LiteralPath $wavPath -Algorithm SHA256).Hash.ToLowerInvariant() }
    blender = [ordered]@{ fps = 30; first_frame = 1; end_frame = 1 + [int][Math]::Ceiling($result.duration_s * 30); time_to_frame = 'frame = 1 + time_s * 30' }
    event_count = $result.visemes.Count
    nonzero_viseme_count = $nonzeroVisemeCount
    event_times_within_audio = $eventTimeRangeValid
    maximum_event_end_s = $maxEventEnd
    unique_visemes = @($result.visemes.viseme | Sort-Object -Unique)
    recommended_track = 'speech_envelope.json'
    track_reason = $(if($visemeObserved) { 'Nonzero events exist, but Mandarin viseme correctness has not been validated. Use amplitude for the first verified preview.' } else { 'This Chinese voice emitted no nonzero viseme events. Use measured amplitude only; do not fabricate phonemes.' })
    raw_events_file = 'speech_events.json'
    envelope_file = 'speech_envelope.json'
    ssml_file = 'speech_fixture.ssml'
    limitations = @('Synthetic Windows voice for repeatable offline playback only.', 'Amplitude controls opening and silence closure, not vowel identity or lip articulation.', 'No user microphone, paid API, or model download is used.')
}

$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $outputRoot 'speech_fixture.ssml'), $ssml, $utf8)
[IO.File]::WriteAllText((Join-Path $outputRoot 'speech_events.json'), ($raw | ConvertTo-Json -Depth 10), $utf8)
[IO.File]::WriteAllText((Join-Path $outputRoot 'speech_envelope.json'), ($envelope | ConvertTo-Json -Depth 10), $utf8)
[IO.File]::WriteAllText((Join-Path $outputRoot 'manifest.json'), ($manifest | ConvertTo-Json -Depth 10), $utf8)
$manifest | ConvertTo-Json -Depth 6
