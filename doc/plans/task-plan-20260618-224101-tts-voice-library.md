# TTS voice library modal plan

1. Add backend Higgs voice preset persistence so saved reference audio, reference URL, transcript, and Code JSON survive restarts.
2. Merge local voice presets into the Higgs voice list and let TTS payload construction resolve a selected preset by voice name.
3. Refactor the desktop TTS model settings into a compact summary plus a modal for service, voice upload, preset selection, and advanced Higgs parameters.
4. Add focused backend tests and run frontend/backend validation.
5. Update CHANGELOG and desktop TTS voice documentation.
