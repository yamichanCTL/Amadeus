项目目录为/home/yami/AI/asrapp
阅读流式识别方案/home/yami/AI/asrapp/doc/streaming.md，
vad模型在/home/yami/AI/asrapp/backend/models/fireredasr2/FireRedVAD，vad使用参考项目/home/yami/AI/audio/FireRedASR2S/examples_infer/vad，
要求：
1.修改后端代码/home/yami/AI/asrapp/backend，增加对应伪流式功能，流式模型默认使用sensevoice small （/home/yami/AI/asrapp/backend/models/SenseVoiceSmall）+  firered2asr协同推理，sensevoice 推理参考项目/home/yami/AI/audio/ASR/SenseVoice，vad检测到有人说话开始到结束前使用sensevoice small一小段时间一次推理， 每次vad介绍使用firered2asr推一遍完整音频，覆盖安卓端结果。
2.后端支持音频记录分类，按用户/日/type(实时转录/一段语音转写)保存，包含音频文件和json结果文件，json中记录现实时间，用户在什么时间说的
3.安卓端代码对应优化/home/yami/AI/asrapp/frontend/android，同时支持锁屏后继续识别推理（目前有问题不能锁屏后收集音频继续推理），转写和实时推理记录按键区分开。
