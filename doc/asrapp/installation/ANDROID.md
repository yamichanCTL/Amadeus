# Android 环境

> **父文档**: [← 返回环境安装总览](README.md)
> **子文档**: [后端环境](BACKEND.md) · [迁移检查表](MIGRATION.md)

## 工具链

- JDK 17。
- Android SDK 35；最低系统 API 26，目标 API 35。
- Gradle Wrapper 8.10.2、Android Gradle Plugin 8.7.3、Kotlin/Compose 插件 2.0.21。
- Android Studio 可直接打开 `frontend/android`。

应用依赖由 Gradle 固定，包括 Compose BOM `2024.12.01`、Activity Compose `1.10.0`、Lifecycle `2.8.7`、OkHttp `4.12.0`、Kotlin Coroutines Android `1.9.0` 与 Kotlin Serialization JSON `1.7.3`。

`local.properties` 是机器专属文件，不要迁移或提交；在目标机器写入实际 SDK 路径：

```properties
sdk.dir=/actual/path/to/Android/Sdk
```

## 构建

```bash
cd /path/to/asrapp/frontend/android
./gradlew :app:assembleDebug
```

APK 输出：`app/build/outputs/apk/debug/app-debug.apk`。首次构建需要访问 Gradle/Maven 仓库；离线迁移不能只复制一部分 Gradle 缓存，建议在联网环境完成一次依赖解析。

## 连接后端

真机不能用 `127.0.0.1` 访问电脑后端，应填写电脑的局域网地址并开放后端端口；模拟器访问宿主机通常使用 `10.0.2.2:8000`。应用允许开发期明文 HTTP，生产部署建议 HTTPS/WSS。

构建成功只证明协议和代码可编译；还需在目标设备验证录音权限、前台服务、锁屏持续识别、蓝牙/系统输入路由以及 HTTP/WS 可达性。
