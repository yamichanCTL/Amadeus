# Android 演示环境调试步骤

这份指南按 VS Code + Gradle + Android SDK/ADB 的方式调试 `frontend/android`。

## 1. 先确认命令行环境

VS Code 扩展只是编辑器能力，真正构建还需要系统能找到这些命令：

```bash
java -version
javac -version
gradle -v
adb devices -l
emulator -list-avds
```

如果任一命令不存在，先安装或配置 PATH。

推荐版本：

- JDK 17
- Android SDK Platform 35
- Android SDK Build-Tools 35.x
- Android SDK Platform-Tools
- Gradle 8.9 或更高

常见 Linux 环境变量：

```bash
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=$HOME/Android/Sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
```

如果 SDK 不在默认位置，在 `frontend/android` 创建 `local.properties`：

```properties
sdk.dir=/你的/Android/Sdk
```

仓库提供了 `local.properties.example` 作为模板。

当前已经验证 `./gradlew -v` 可用；如果 `./gradlew :app:assembleDebug`
提示 `SDK location not found`，说明还缺 Android SDK。你可以二选一：

方式 A：用 Android Studio 安装 SDK

1. 打开 Android Studio。
2. 进入 `Settings > Languages & Frameworks > Android SDK`。
3. 安装 `Android SDK Platform 35`。
4. 在 `SDK Tools` 中安装 `Android SDK Build-Tools 35.x`、`Android SDK Platform-Tools`、`Android Emulator`、`Android SDK Command-line Tools`。
5. 记下 SDK 路径，例如 `~/Android/Sdk` 或 Windows 侧 `%LOCALAPPDATA%\Android\Sdk`。

方式 B：用 Google 官方 Android CLI

官方本地安装命令如下。它会执行 Google 下载的安装脚本，只在你信任该脚本时运行：

```bash
curl -fsSL https://dl.google.com/android/cli/latest/linux_x86_64/install.sh | bash
```

安装后重开终端，确认：

```bash
sdkmanager --version
```

然后安装项目需要的 SDK 包：

```bash
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" "emulator" "cmdline-tools;latest"
```

最后创建 `local.properties`：

```bash
cd ~/AI/asrapp/frontend/android
cp local.properties.example local.properties
```

把其中的 `sdk.dir` 改成真实 SDK 路径。

## 2. 准备后端演示服务

从仓库根目录启动后端：

```bash
cd ~/AI/asrapp/backend
uv run uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

在电脑浏览器或终端验证：

```bash
curl http://127.0.0.1:8001/v1/health
curl http://127.0.0.1:8001/v1/models
```

模拟器访问电脑本机服务时，不要填 `127.0.0.1`，要在 App 设置页填：

```text
http://10.0.2.2:8001
```

真机调试时，手机和电脑在同一局域网，设置页填电脑局域网 IP：

```text
http://电脑IP:8001
```

## 3. 启动模拟器或连接真机

查看可用模拟器：

```bash
emulator -list-avds
```

启动某个模拟器：

```bash
emulator -avd 你的AVD名字
```

或连接真机并打开 USB 调试，然后确认：

```bash
adb devices -l
```

## 4. 在 VS Code 构建并运行

打开目录：

```bash
code ~/AI/asrapp/frontend/android
```

然后依次运行 VS Code 命令：

1. `Terminal: Run Task`
2. `Android: connected devices`
3. `Android: build debug APK`
4. `Android: launch app`
5. 另开一个任务运行 `Android: logcat ASRApp`

也可以手动执行：

```bash
cd ~/AI/asrapp/frontend/android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.asrapp.android/.MainActivity
```

如果 `gradle wrapper --gradle-version 8.10.2` 报
`Test of distribution url ... failed`，通常是 `services.gradle.org`
访问失败。项目已内置 wrapper 文件，并把 Gradle 下载地址配置为腾讯云镜像：

```text
gradle/wrapper/gradle-wrapper.properties
```

直接运行 `./gradlew :app:assembleDebug` 即可，不需要再执行 `gradle wrapper`。

## 5. App 内演示流程

1. 打开“设置”，如果使用本机后端和模拟器，后端地址改成 `http://10.0.2.2:8001`。
2. 点“保存设置”，顶部状态应显示后端可用。
3. 打开“模型”，点刷新，确认能列出后端引擎。
4. 选择一个引擎，必要时点“加载”。
5. 回到“转写”，点“选择音频”上传音频，或点“开始录音”录一小段。
6. 识别完成后检查结果、分段、复制、分享和历史记录。

## 6. 常见问题

- `java: command not found`：JDK 没安装或 PATH 没配置。
- `gradle: command not found`：Gradle CLI 没安装；VS Code 的 Gradle 扩展不等于系统 Gradle。
- `./gradlew` 下载 Gradle 失败：检查网络，或把 `gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 换成可访问的 Gradle 镜像/本地 zip。
- `adb: command not found`：Android SDK Platform-Tools 没安装或没进 PATH。
- App 连不上本机后端：模拟器里用 `http://10.0.2.2:8001`，真机用电脑局域网 IP。
- 上传后 500：通常是后端模型未加载、模型文件缺失，或所选 engine 与后端可用引擎不一致。
- 录音无结果：确认已授予麦克风权限，并录制至少 1-2 秒。
