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
    private val preferredDeviceKey: String = "",
    private val onRouteChanged: (AudioRouteSelection) -> Unit = {},
) {
    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(AudioManager::class.java)
    private var callbackRegistered = false
    private var originalMode: Int? = null
    private var originalScoOn: Boolean? = null
    private var bluetoothRouteConfigured = false

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
        configureRoute(inputDevice)
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
        restoreRoute()
    }

    private fun preferredInputDevice(): AudioDeviceInfo? {
        val devices = runCatching {
            audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { it.isSource }
        }.getOrDefault(emptyList())

        if (preferredDeviceKey.isNotBlank()) {
            devices.firstOrNull { keyFor(it) == preferredDeviceKey && it.isSupportedInput() }
                ?.let { return it }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && hasBluetoothConnectPermission()) {
            val communicationDevice = runCatching { audioManager.communicationDevice }.getOrNull()
            if (communicationDevice?.isSupportedInput() == true) {
                devices.firstOrNull { it.id == communicationDevice.id && it.isSupportedInput() }
                    ?.let { return it }
                devices.firstOrNull { it.type == communicationDevice.type && it.isSupportedInput() }
                    ?.let { return it }
            }
        }

        if (preferredDeviceKey.isBlank()) {
            devices.firstOrNull { it.isBluetoothInput() && it.isSupportedInput() }
                ?.let { return it }
        }

        return null
    }

    private fun configureRoute(inputDevice: AudioDeviceInfo?) {
        if (inputDevice?.isBluetoothInput() != true || !hasBluetoothConnectPermission()) {
            if (bluetoothRouteConfigured) restoreRoute()
            return
        }
        if (originalMode == null) originalMode = audioManager.mode
        if (originalScoOn == null) {
            @Suppress("DEPRECATION")
            originalScoOn = audioManager.isBluetoothScoOn
        }

        bluetoothRouteConfigured = true
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            communicationRouteFor(inputDevice)?.let { route ->
                runCatching { audioManager.setCommunicationDevice(route) }
            }
        } else {
            @Suppress("DEPRECATION")
            runCatching {
                audioManager.startBluetoothSco()
                audioManager.isBluetoothScoOn = true
            }
        }
    }

    private fun restoreRoute() {
        if (!bluetoothRouteConfigured && originalMode == null && originalScoOn == null) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching { audioManager.clearCommunicationDevice() }
        } else {
            @Suppress("DEPRECATION")
            runCatching {
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = originalScoOn ?: false
            }
        }
        originalMode?.let { runCatching { audioManager.mode = it } }
        originalMode = null
        originalScoOn = null
        bluetoothRouteConfigured = false
    }

    private fun communicationRouteFor(inputDevice: AudioDeviceInfo): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        return runCatching {
            audioManager.availableCommunicationDevices.firstOrNull { it.id == inputDevice.id }
                ?: audioManager.availableCommunicationDevices.firstOrNull { it.type == inputDevice.type }
                ?: audioManager.availableCommunicationDevices.firstOrNull { it.isBluetoothInput() }
        }.getOrNull()
    }

    private fun hasBluetoothConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    companion object {
        fun keyFor(device: AudioDeviceInfo): String =
            "${device.type}:${device.productName?.toString().orEmpty()}"

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
