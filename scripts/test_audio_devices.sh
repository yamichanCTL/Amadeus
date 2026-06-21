#!/usr/bin/env bash
set -euo pipefail

export PULSE_SERVER="${PULSE_SERVER:-unix:/mnt/wslg/PulseServer}"

sink="${AUDIO_TEST_SINK:-@DEFAULT_SINK@}"
source="${AUDIO_TEST_SOURCE:-@DEFAULT_SOURCE@}"
duration="${AUDIO_TEST_RECORD_SECONDS:-2}"
output_dir="${AUDIO_TEST_OUTPUT_DIR:-/tmp/asrapp-audio-device-test}"
mkdir -p "$output_dir"

tone_file="$output_dir/output-test.wav"
capture_file="$output_dir/input-test.wav"
echo_probe_file="$output_dir/input-during-output-test.wav"

echo "[Pulse server]"
pactl info
echo
echo "[Output devices]"
pactl list short sinks
echo
echo "[Input devices]"
pactl list short sources

ffmpeg -hide_banner -loglevel error \
  -f lavfi -i "sine=frequency=660:sample_rate=44100:duration=0.35" \
  -filter:a "volume=0.06" -ac 2 -y "$tone_file"

echo
echo "[Output test] sink=$sink"
paplay --device="$sink" --client-name=asrapp-device-test "$tone_file"
echo "output playback accepted"

echo
echo "[Input test] source=$source duration=${duration}s"
capture_status=0
timeout "${duration}s" parec \
  --device="$source" \
  --client-name=asrapp-device-test \
  --rate=16000 \
  --channels=1 \
  --format=s16le \
  --file-format=wav > "$capture_file" || capture_status=$?
if [[ "$capture_status" -ne 0 && "$capture_status" -ne 124 ]]; then
  echo "input capture failed with status $capture_status" >&2
  exit "$capture_status"
fi

ffprobe -v error \
  -show_entries stream=codec_name,sample_rate,channels,duration \
  -of default=noprint_wrappers=1 "$capture_file"
ffmpeg -hide_banner -i "$capture_file" -af volumedetect -f null - 2>&1 \
  | sed -n '/mean_volume/p;/max_volume/p'
echo "capture saved: $capture_file"

echo
echo "[Input/output isolation probe] source=$source sink=$sink"
echo_probe_status=0
timeout 2s parec \
  --device="$source" \
  --client-name=asrapp-echo-probe \
  --rate=16000 \
  --channels=1 \
  --format=s16le \
  --file-format=wav > "$echo_probe_file" &
echo_probe_pid=$!
sleep 0.35
paplay --device="$sink" --client-name=asrapp-echo-probe "$tone_file"
wait "$echo_probe_pid" || echo_probe_status=$?
if [[ "$echo_probe_status" -ne 0 && "$echo_probe_status" -ne 124 ]]; then
  echo "echo probe capture failed with status $echo_probe_status" >&2
  exit "$echo_probe_status"
fi
ffmpeg -hide_banner -i "$echo_probe_file" -af volumedetect -f null - 2>&1 \
  | sed -n '/mean_volume/p;/max_volume/p'
echo "echo probe saved: $echo_probe_file"
echo "Compare this peak with the baseline input peak; a large increase indicates acoustic feedback."
