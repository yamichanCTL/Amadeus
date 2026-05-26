package com.asrapp.android.service

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import androidx.core.content.ContextCompat

internal data class AudioRouteSelection(
    val inputDevice: AudioDeviceInfo?,
    val audioSource: Int,
)

internal class AudioRouteController(
    context: Context,
    private val onRouteChanged: (AudioRouteSelection) -> Unit = {},
) {
    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(AudioManager::class.java)
    private var callbackRegistered = false

    private val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            onRouteChanged(prepareForRecording())
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            onRouteChanged(prepareForRecording())
        }
    }

    fun start(): AudioRouteSelection {
        if (!callbackRegistered) {
            audioManager.registerAudioDeviceCallback(callback, null)
            callbackRegistered = true
        }
        return prepareForRecording()
    }

    fun prepareForRecording(): AudioRouteSelection {
        val inputDevice = preferredInputDevice()
        return AudioRouteSelection(
            inputDevice = inputDevice,
            audioSource = audioSourceFor(inputDevice),
        )
    }

    fun stop() {
        if (callbackRegistered) {
            runCatching { audioManager.unregisterAudioDeviceCallback(callback) }
            callbackRegistered = false
        }
    }

    private fun preferredInputDevice(): AudioDeviceInfo? {
        val devices = runCatching {
            audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { it.isSource }
        }.getOrDefault(emptyList())

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && hasBluetoothConnectPermission()) {
            val communicationDevice = runCatching { audioManager.communicationDevice }.getOrNull()
            if (communicationDevice?.isSupportedInput() == true) {
                devices.firstOrNull { it.id == communicationDevice.id && it.isSupportedInput() }
                    ?.let { return it }
                devices.firstOrNull { it.type == communicationDevice.type && it.isSupportedInput() }
                    ?.let { return it }
            }
        }

        val priority = listOf(
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_BUILTIN_MIC,
        )
        return priority
            .asSequence()
            .filter { it >= 0 }
            .mapNotNull { type -> devices.firstOrNull { it.type == type && it.isSupportedInput() } }
            .firstOrNull()
    }

    private fun hasBluetoothConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    companion object {
        fun audioSourceFor(device: AudioDeviceInfo?): Int =
            if (device?.isBluetoothInput() == true) {
                MediaRecorder.AudioSource.VOICE_COMMUNICATION
            } else {
                MediaRecorder.AudioSource.VOICE_RECOGNITION
            }

        fun label(device: AudioDeviceInfo?): String =
            device?.productName?.toString()?.takeIf { it.isNotBlank() }
                ?: when (device?.type) {
                    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "蓝牙麦克风"
                    AudioDeviceInfo.TYPE_USB_HEADSET -> "USB 麦克风"
                    AudioDeviceInfo.TYPE_USB_DEVICE -> "USB 音频输入"
                    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "有线耳机麦克风"
                    AudioDeviceInfo.TYPE_BUILTIN_MIC -> "内置麦克风"
                    else -> "系统默认麦克风"
                }
    }
}

private fun isBluetoothType(type: Int): Boolean =
    type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET)

private fun AudioDeviceInfo.isBluetoothInput(): Boolean =
    isBluetoothType(type)

private fun AudioDeviceInfo.isSupportedInput(): Boolean =
    type == AudioDeviceInfo.TYPE_BUILTIN_MIC ||
        type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
        type == AudioDeviceInfo.TYPE_USB_HEADSET ||
        type == AudioDeviceInfo.TYPE_USB_DEVICE ||
        isBluetoothInput()
