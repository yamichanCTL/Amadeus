package com.asrapp.android.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.asrapp.android.R
import com.asrapp.android.data.AppSettings
import com.asrapp.android.data.ArchiveSummaryResult
import com.asrapp.android.data.HistoryItem
import com.asrapp.android.data.ModelInfo
import com.asrapp.android.data.TranscriptSegment
import com.asrapp.android.service.AudioRouteController
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

private val Indigo = Color(0xFF4E63F6)
private val Violet = Color(0xFF8B5CF6)
private val SkyBlue = Color(0xFF62C6FF)
private val Mint = Color(0xFF7EE7D0)
private val MilkWhite = Color(0xFFFDFBFF)
private val Ink = Color(0xFF12172F)
private val MutedInk = Color(0xFF667093)
private val GlassLine = Color(0xFFE4EEFF)

private fun appBackgroundBrush(): Brush =
    Brush.linearGradient(
        colors = listOf(
            Color(0xFFF8FCFF),
            Color(0xFFEAF5FF),
            Color(0xFFF2ECFF),
            Color(0xFFFFFBF8),
        ),
        start = Offset(0f, 0f),
        end = Offset(900f, 1600f),
    )

@Composable
fun AsrTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Indigo,
            secondary = Violet,
            tertiary = SkyBlue,
            background = MilkWhite,
            surface = Color.White,
            surfaceVariant = Color(0xFFF0F3FF),
            onPrimary = Color.White,
            onSurface = Ink,
            onSurfaceVariant = MutedInk,
        ),
        content = content,
    )
}

@Composable
fun AsrApp(viewModel: MainViewModel) {
    val state = viewModel.uiState
    val snackbarHost = remember { SnackbarHostState() }

    LaunchedEffect(state.error) {
        state.error?.let { snackbarHost.showSnackbar(it) }
    }

    Scaffold(
        containerColor = Color.Transparent,
        bottomBar = {
            FloatingBottomNav(
                selected = state.page,
                onSelect = viewModel::selectPage,
            )
        },
        snackbarHost = { SnackbarHost(snackbarHost) },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .background(appBackgroundBrush())
                .padding(padding),
        ) {
            when (state.page) {
                AppPage.Transcribe -> TranscribePage(viewModel)
                AppPage.Summary -> SummaryPage(viewModel)
                AppPage.Models -> ModelsPage(viewModel)
                AppPage.History -> HistoryPage(viewModel)
                AppPage.Settings -> SettingsPage(viewModel)
            }
        }
    }
}

@Composable
private fun FloatingBottomNav(selected: AppPage, onSelect: (AppPage) -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp),
        shape = RoundedCornerShape(24.dp),
        color = Color.White.copy(alpha = 0.94f),
        tonalElevation = 4.dp,
        shadowElevation = 8.dp,
        border = BorderStroke(1.dp, Color(0xFFE6ECF8)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BottomNavItem(
                selected = selected == AppPage.Transcribe,
                title = "录音识别",
                icon = Icons.Default.Mic,
                onClick = { onSelect(AppPage.Transcribe) },
            )
            BottomNavItem(
                selected = selected == AppPage.History,
                title = "历史记录",
                icon = Icons.Default.History,
                onClick = { onSelect(AppPage.History) },
            )
            BottomNavItem(
                selected = selected == AppPage.Summary,
                title = "当日总结",
                icon = Icons.Default.Info,
                onClick = { onSelect(AppPage.Summary) },
            )
            BottomNavItem(
                selected = selected == AppPage.Settings || selected == AppPage.Models,
                title = "我的",
                icon = Icons.Default.Home,
                onClick = { onSelect(AppPage.Settings) },
            )
        }
    }
}

@Composable
private fun BottomNavItem(
    selected: Boolean,
    title: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit,
) {
    val tint = if (selected) Indigo else Color(0xFF596275)
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(18.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 2.dp)
            .width(66.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(
                    if (selected) {
                        Color(0xFFEAF0FF)
                    } else {
                        Color.Transparent
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon,
                contentDescription = title,
                tint = tint,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            title,
            color = tint,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
        )
        Box(
            Modifier
                .height(3.dp)
                .width(if (selected) 22.dp else 1.dp)
                .clip(RoundedCornerShape(99.dp))
                .background(if (selected) Indigo else Color.Transparent),
        )
    }
}

@Composable
private fun BottomDivider() {
    Box(
        Modifier
            .height(40.dp)
            .width(1.dp)
            .background(Color(0x1A54639C)),
    )
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun TranscribePage(viewModel: MainViewModel) {
    val state = viewModel.uiState
    val context = LocalContext.current
    val recordingPermissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        if (grants[Manifest.permission.RECORD_AUDIO] == true) {
            viewModel.startRecording()
        } else {
            viewModel.setError("需要麦克风权限才能录音")
        }
    }
    val streamingPermissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        if (grants[Manifest.permission.RECORD_AUDIO] == true) {
            viewModel.startStreamingRecognition()
        } else {
            viewModel.setError("需要麦克风权限才能实时转录")
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val compact = maxHeight < 720.dp
        val veryCompact = maxHeight < 620.dp
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = if (compact) 14.dp else 18.dp, vertical = if (compact) 8.dp else 14.dp),
            verticalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 12.dp),
        ) {
            ReferenceHomeHeader(
                state = state,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(if (compact) 0.15f else 0.16f),
                compact = compact,
                onModels = { viewModel.selectPage(AppPage.Models) },
                onSettings = { viewModel.selectPage(AppPage.Settings) },
                onRefresh = { viewModel.checkServer(); viewModel.refreshModels() },
            )
            LiveSubtitleStrip(
                state = state,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(if (veryCompact) 0.08f else 0.09f),
                compact = compact,
            )
            TranscriptPanel(
                state = state,
                title = "实时转写",
                modifier = Modifier.weight(if (compact) 0.52f else 0.49f),
                onClear = viewModel::clearCurrentResult,
            )
            ReferenceControlStage(
                state = state,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(if (veryCompact) 0.25f else 0.26f),
                compact = compact,
                onRealtimeClick = {
                    if (state.status == WorkStatus.Streaming) {
                        viewModel.stopStreamingRecognition()
                    } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        viewModel.startStreamingRecognition()
                    } else {
                        streamingPermissions.launch(micForegroundPermissions())
                    }
                },
                onRecordClick = {
                    if (state.status == WorkStatus.Recording) {
                        viewModel.stopRecordingAndTranscribe()
                    } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        viewModel.startRecording()
                    } else {
                        recordingPermissions.launch(micForegroundPermissions())
                    }
                },
                onCancelClick = viewModel::cancelCurrentTask,
            )
        }
    }
}

@Composable
private fun ReferenceHomeHeader(
    state: AppUiState,
    modifier: Modifier = Modifier,
    compact: Boolean,
    onModels: () -> Unit,
    onSettings: () -> Unit,
    onRefresh: () -> Unit,
) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(if (compact) 2.dp else 5.dp),
        ) {
            Text(
                "ASRAPP",
                color = Indigo,
                fontSize = if (compact) 32.sp else 38.sp,
                fontWeight = FontWeight.ExtraBold,
                letterSpacing = 0.sp,
                maxLines = 1,
            )
            Text(
                "智能语音识别助手",
                color = Color(0xFF59658B),
                fontSize = if (compact) 13.sp else 16.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (state.serverConnected) Mint else Color(0xFFE24A68)),
                )
                Text(
                    state.serverMessage,
                    color = if (state.serverConnected) Color(0xFF1D806A) else Color(0xFFB73650),
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                IconButton(onClick = onRefresh, modifier = Modifier.size(28.dp)) {
                    Icon(Icons.Default.Refresh, contentDescription = "刷新连接", tint = MutedInk, modifier = Modifier.size(18.dp))
                }
            }
        }
        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(if (compact) 7.dp else 10.dp),
        ) {
            IconButton(
                onClick = onSettings,
                modifier = Modifier
                    .size(if (compact) 42.dp else 48.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.92f))
                    .border(1.dp, Color(0xFFE5ECF8), CircleShape),
            ) {
                Icon(Icons.Default.Settings, contentDescription = "设置", tint = Ink, modifier = Modifier.size(if (compact) 21.dp else 24.dp))
            }
            ModelSelector(
                state = state,
                onClick = onModels,
                modifier = Modifier.widthIn(min = if (compact) 126.dp else 150.dp, max = if (compact) 148.dp else 178.dp),
            )
        }
    }
}

@Composable
private fun TopStatusBar(
    state: AppUiState,
    onModels: () -> Unit,
    onSettings: () -> Unit,
    onRefresh: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(
                "ASRAPP",
                color = Indigo,
                fontSize = 28.sp,
                fontWeight = FontWeight.ExtraBold,
                letterSpacing = 0.sp,
                maxLines = 1,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (state.serverConnected) Color(0xFF24B48E) else Color(0xFFE24A68)),
                )
                Text(
                    state.serverMessage,
                    color = if (state.serverConnected) Color(0xFF1D806A) else Color(0xFFB73650),
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                IconButton(onClick = onRefresh, modifier = Modifier.size(30.dp)) {
                    Icon(Icons.Default.Refresh, contentDescription = "刷新连接", tint = MutedInk, modifier = Modifier.size(18.dp))
                }
            }
        }
        ModelSelector(state = state, onClick = onModels)
        IconButton(
            onClick = onSettings,
            modifier = Modifier
                .size(42.dp)
                .clip(CircleShape)
                .background(Color.White.copy(alpha = 0.92f))
                .border(1.dp, Color(0xFFE5ECF8), CircleShape),
        ) {
            Icon(Icons.Default.Settings, contentDescription = "设置", tint = Ink, modifier = Modifier.size(22.dp))
        }
    }
}

@Composable
private fun ModelSelector(state: AppUiState, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        modifier = modifier.widthIn(min = 112.dp, max = 160.dp),
        shape = RoundedCornerShape(18.dp),
        color = Color.White.copy(alpha = 0.94f),
        shadowElevation = 3.dp,
        border = BorderStroke(1.dp, Color(0xFFE5ECF8)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 11.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Icon(Icons.Default.Build, contentDescription = null, tint = Indigo, modifier = Modifier.size(17.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("模型", color = MutedInk, fontSize = 10.sp, maxLines = 1)
                Text(
                    selectedEngineLabel(state.settings),
                    color = Ink,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun AssistantStage(
    state: AppUiState,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    Surface(
        modifier = modifier.height(if (compact) 118.dp else 142.dp),
        shape = RoundedCornerShape(24.dp),
        color = Color.White.copy(alpha = 0.72f),
        border = BorderStroke(1.dp, Color(0xFFE3EBFA)),
        shadowElevation = 4.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = 18.dp, top = 14.dp, end = 6.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    assistantHeadline(state.status),
                    color = Ink,
                    fontSize = if (compact) 18.sp else 20.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    state.statusMessage.ifBlank { "就绪" },
                    color = MutedInk,
                    fontSize = 13.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    StatusPill(if (state.serverConnected) "后端在线" else "后端离线")
                    StatusPill("语言 ${state.settings.defaultLanguage.ifBlank { "auto" }}")
                }
            }
            AssistantImage(
                resId = assistantResourceForStatus(state.status),
                modifier = Modifier
                    .width(if (compact) 104.dp else 132.dp)
                    .height(if (compact) 120.dp else 150.dp),
            )
        }
    }
}

@Composable
private fun StatusPill(text: String) {
    Surface(
        shape = RoundedCornerShape(99.dp),
        color = Color(0xFFF1F5FF),
        border = BorderStroke(1.dp, Color(0xFFE0E8FA)),
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
            color = Color(0xFF4C5E86),
            fontSize = 11.sp,
            maxLines = 1,
        )
    }
}

@Composable
private fun TranscriptPanel(
    state: AppUiState,
    title: String,
    modifier: Modifier = Modifier,
    onClear: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val text = state.displayTranscriptText()
    val empty = text.isBlank()
    val visibleText = text.ifBlank { "开始实时识别、录音或导入音频后，转写文本会显示在这里。" }
    val scrollState = rememberScrollState()
    val recognizing = state.status == WorkStatus.Streaming || state.status == WorkStatus.Recording

    LaunchedEffect(visibleText) {
        delay(60)
        scrollState.animateScrollTo(scrollState.maxValue)
    }

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 170.dp),
        shape = RoundedCornerShape(24.dp),
        color = Color.White.copy(alpha = 0.96f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
        shadowElevation = 3.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(title, color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    Text(statusLabel(state), color = MutedInk, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(
                        Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(if (recognizing) Color(0xFF24B48E) else Color(0xFFC7D0E3)),
                    )
                    Text(if (recognizing) "识别中" else "待命", color = MutedInk, fontSize = 12.sp)
                }
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(scrollState),
            ) {
                Text(
                    visibleText,
                    color = if (empty) MutedInk else Ink,
                    fontSize = if (empty) 16.sp else 19.sp,
                    lineHeight = if (empty) 24.sp else 29.sp,
                    fontWeight = if (empty) FontWeight.Normal else FontWeight.Medium,
                )
            }
            AudioWaveform(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(28.dp),
                active = recognizing,
                pulse = if (recognizing) 0.65f else 0f,
            )
            ResultActions(
                text = text,
                wordCount = text.length,
                onCopy = { copyText(context, text) },
                onShare = { shareText(context, text) },
                onClear = onClear,
            )
        }
    }
}

@Composable
private fun ResultActions(
    text: String,
    wordCount: Int,
    onCopy: () -> Unit,
    onShare: () -> Unit,
    onClear: (() -> Unit)?,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        TextButton(onClick = onCopy, enabled = text.isNotBlank(), contentPadding = PaddingValues(horizontal = 8.dp)) {
            Icon(Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(4.dp))
            Text("复制", fontSize = 12.sp)
        }
        TextButton(onClick = onShare, enabled = text.isNotBlank(), contentPadding = PaddingValues(horizontal = 8.dp)) {
            Icon(Icons.Default.Share, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(4.dp))
            Text("分享", fontSize = 12.sp)
        }
        if (onClear != null) {
            TextButton(onClick = onClear, enabled = text.isNotBlank(), contentPadding = PaddingValues(horizontal = 8.dp)) {
                Icon(Icons.Default.Delete, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("清空", fontSize = 12.sp)
            }
        }
        Spacer(Modifier.weight(1f))
        Text("字数 $wordCount", color = MutedInk, fontSize = 12.sp, maxLines = 1)
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun PrimaryMicControl(
    state: AppUiState,
    compact: Boolean,
    onRealtimeClick: () -> Unit,
    onRecordClick: () -> Unit,
    onCancelClick: () -> Unit,
) {
    val busy = state.status in setOf(WorkStatus.Checking, WorkStatus.Uploading, WorkStatus.Polling, WorkStatus.Processing)
    val streaming = state.status == WorkStatus.Streaming
    val recording = state.status == WorkStatus.Recording
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(24.dp),
        color = Color.White.copy(alpha = 0.96f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
        shadowElevation = 3.dp,
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(if (compact) 72.dp else 82.dp)
                    .clip(CircleShape)
                    .background(Brush.linearGradient(listOf(Color(0xFF65CBFF), Indigo, Violet)))
                    .border(3.dp, Color.White.copy(alpha = 0.82f), CircleShape)
                    .clickable(enabled = !busy && !recording, onClick = onRealtimeClick),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (streaming) Icons.Default.Stop else Icons.Default.Mic,
                    contentDescription = if (streaming) "停止实时识别" else "开始实时识别",
                    tint = Color.White,
                    modifier = Modifier.size(if (compact) 34.dp else 39.dp),
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    primaryActionLabel(state),
                    color = Ink,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(
                        onClick = onRecordClick,
                        enabled = !streaming && !busy,
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Icon(if (recording) Icons.Default.Stop else Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(if (recording) "结束录音" else "录音转写", fontSize = 12.sp)
                    }
                    if (state.currentTaskId != null) {
                        OutlinedButton(
                            onClick = onCancelClick,
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                        ) {
                            Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("取消任务", fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String, action: @Composable (() -> Unit)? = null) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, color = Ink, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        action?.invoke()
    }
}

@Composable
private fun EmptyState(message: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = Color.White.copy(alpha = 0.9f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
    ) {
        Text(
            message,
            modifier = Modifier.padding(18.dp),
            color = MutedInk,
            fontSize = 14.sp,
            lineHeight = 21.sp,
        )
    }
}

private fun assistantHeadline(status: WorkStatus): String =
    when (status) {
        WorkStatus.Streaming -> "正在实时聆听"
        WorkStatus.Recording -> "正在录音"
        WorkStatus.Uploading, WorkStatus.Polling, WorkStatus.Processing -> "正在处理音频"
        WorkStatus.Done -> "转写已完成"
        WorkStatus.Error -> "需要检查状态"
        else -> "准备开始识别"
    }

private fun primaryActionLabel(state: AppUiState): String =
    when (state.status) {
        WorkStatus.Streaming -> "点击麦克风停止实时识别"
        WorkStatus.Recording -> "录音进行中，可结束并转写"
        WorkStatus.Uploading, WorkStatus.Polling, WorkStatus.Processing -> state.statusMessage
        WorkStatus.Error -> "检查错误后重新开始"
        else -> "点击麦克风开始实时识别"
    }

private fun statusLabel(state: AppUiState): String =
    listOfNotNull(
        state.currentResult?.filename,
        state.currentResult?.engineUsed ?: selectedEngineLabel(state.settings),
        state.currentResult?.language ?: state.settings.defaultLanguage.takeIf { it.isNotBlank() },
    ).joinToString(" / ").ifBlank { state.statusMessage }

private fun AppUiState.displayTranscriptText(): String {
    val liveText = listOf(streamCommittedText.trim(), streamPartialText.trim())
        .filter { it.isNotBlank() }
        .joinToString("\n")
    return liveText.ifBlank { currentResult?.fullText?.trim().orEmpty() }
}

private fun subtitleSnippets(state: AppUiState): List<String> {
    val parts = state.displayTranscriptText()
        .replace('\n', ' ')
        .split(Regex("[，。,.!?！？\\s]+"))
        .map { it.trim() }
        .filter { it.isNotBlank() }
        .take(3)
    val fallback = when (state.status) {
        WorkStatus.Streaming -> listOf("正在监听语音", "实时内容会滚动显示", "说完后自动整理")
        WorkStatus.Recording -> listOf("正在录音", "结束后上传转写", "请保持声音清晰")
        WorkStatus.Uploading, WorkStatus.Polling, WorkStatus.Processing -> listOf("音频处理中", "等待后端返回", "结果即将显示")
        else -> listOf("点击麦克风开始", "支持实时识别和录音转写", "结果可复制分享")
    }
    return (parts + fallback).take(3)
}

@Composable
private fun SecondaryActionRow(
    state: AppUiState,
    onRecordClick: () -> Unit,
    onRealtimeClick: () -> Unit,
    onCancelClick: () -> Unit,
    compact: Boolean,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(if (compact) 34.dp else 38.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(
            onClick = onRecordClick,
            enabled = state.status != WorkStatus.Streaming,
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
        ) {
            Icon(
                if (state.status == WorkStatus.Recording) Icons.Default.Stop else Icons.Default.Mic,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(4.dp))
            Text(if (state.status == WorkStatus.Recording) "结束录音" else "录音转写", fontSize = 12.sp, maxLines = 1)
        }
        TextButton(
            onClick = onRealtimeClick,
            enabled = state.status != WorkStatus.Recording,
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
        ) {
            Icon(
                if (state.status == WorkStatus.Streaming) Icons.Default.Stop else Icons.Default.GraphicEq,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(4.dp))
            Text(if (state.status == WorkStatus.Streaming) "停止实时" else "实时转写", fontSize = 12.sp, maxLines = 1)
        }
        if (state.currentTaskId != null) {
            TextButton(
                onClick = onCancelClick,
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
            ) {
                Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("取消", fontSize = 12.sp, maxLines = 1)
            }
        }
    }
}

@Composable
private fun LiveSubtitleStrip(
    state: AppUiState,
    modifier: Modifier = Modifier,
    compact: Boolean,
) {
    val snippets = subtitleSnippets(state)
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(if (compact) 4.dp else 7.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Default.GraphicEq, contentDescription = null, tint = Indigo, modifier = Modifier.size(if (compact) 18.dp else 20.dp))
            Text("实时字幕", color = Indigo, fontWeight = FontWeight.Bold, fontSize = if (compact) 14.sp else 16.sp)
            Text(if (state.status == WorkStatus.Streaming) "（滚动中）" else "（待命）", color = Violet.copy(alpha = 0.72f), fontSize = if (compact) 12.sp else 14.sp)
        }
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            shape = RoundedCornerShape(24.dp),
            color = Color.White.copy(alpha = 0.44f),
            border = BorderStroke(1.dp, GlassLine.copy(alpha = 0.88f)),
            shadowElevation = 4.dp,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 12.dp, vertical = if (compact) 5.dp else 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SubtitlePill(snippets[0])
                SubtitleDot()
                SubtitlePill(snippets[1])
                SubtitleDot()
                SubtitlePill(snippets[2])
            }
        }
    }
}

@Composable
private fun RowScope.SubtitlePill(text: String) {
    Surface(
        modifier = Modifier.weight(1f),
        shape = RoundedCornerShape(18.dp),
        color = Color.White.copy(alpha = 0.68f),
        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.85f)),
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
            color = Ink,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun SubtitleDot() {
    Box(
        Modifier
            .size(4.dp)
            .clip(CircleShape)
            .background(Indigo.copy(alpha = 0.58f)),
    )
}

@Composable
private fun ReferenceControlStage(
    state: AppUiState,
    modifier: Modifier = Modifier,
    compact: Boolean,
    onRealtimeClick: () -> Unit,
    onRecordClick: () -> Unit,
    onCancelClick: () -> Unit,
) {
    val busy = state.status in setOf(WorkStatus.Checking, WorkStatus.Uploading, WorkStatus.Polling, WorkStatus.Processing)
    val streaming = state.status == WorkStatus.Streaming
    val recording = state.status == WorkStatus.Recording
    Box(modifier = modifier) {
        Row(
            modifier = Modifier.fillMaxSize(),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            RecognitionSummaryCard(
                state = state,
                modifier = Modifier
                    .weight(0.35f)
                    .heightIn(max = if (compact) 118.dp else 138.dp),
                compact = compact,
            )
            CenterMicColumn(
                state = state,
                busy = busy,
                streaming = streaming,
                recording = recording,
                compact = compact,
                modifier = Modifier.weight(0.30f),
                onRealtimeClick = onRealtimeClick,
                onRecordClick = onRecordClick,
                onCancelClick = onCancelClick,
            )
            Box(
                modifier = Modifier
                    .weight(0.35f)
                    .fillMaxSize(),
                contentAlignment = Alignment.BottomEnd,
            ) {
                AssistantImage(
                    resId = assistantResourceForStatus(state.status),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(if (compact) 110.dp else 140.dp),
                )
                Surface(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .size(if (compact) 34.dp else 40.dp),
                    shape = CircleShape,
                    color = Color.White.copy(alpha = 0.88f),
                    border = BorderStroke(1.dp, Color.White.copy(alpha = 0.95f)),
                    shadowElevation = 4.dp,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text("♥", color = Violet, fontSize = if (compact) 17.sp else 20.sp, textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
}

@Composable
private fun RecognitionSummaryCard(
    state: AppUiState,
    modifier: Modifier = Modifier,
    compact: Boolean,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(if (compact) 18.dp else 22.dp),
        color = Color.White.copy(alpha = 0.82f),
        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.95f)),
        shadowElevation = 5.dp,
    ) {
        Column(
            modifier = Modifier.padding(if (compact) 9.dp else 12.dp),
            verticalArrangement = Arrangement.spacedBy(if (compact) 6.dp else 9.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Icon(Icons.Default.Info, contentDescription = null, tint = Indigo, modifier = Modifier.size(17.dp))
                Text("识别状态", color = Ink, fontWeight = FontWeight.Bold, fontSize = if (compact) 12.sp else 14.sp, maxLines = 1)
            }
            StatusMetric("时长", state.currentResult?.durationSec?.let(::formatSeconds) ?: "00:00")
            StatusMetric("置信度", state.currentResult?.confidence?.let { "%.1f%%".format(it * 100) } ?: "--")
            StatusMetric("语言", state.currentResult?.language ?: state.settings.defaultLanguage.ifBlank { "auto" })
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun CenterMicColumn(
    state: AppUiState,
    busy: Boolean,
    streaming: Boolean,
    recording: Boolean,
    compact: Boolean,
    modifier: Modifier = Modifier,
    onRealtimeClick: () -> Unit,
    onRecordClick: () -> Unit,
    onCancelClick: () -> Unit,
) {
    Column(
        modifier = modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Bottom,
    ) {
        Box(
            modifier = Modifier
                .size(if (compact) 66.dp else 78.dp)
                .clip(CircleShape)
                .background(Brush.linearGradient(listOf(Color(0xFF65CBFF), Indigo, Violet)))
                .border(3.dp, Color.White.copy(alpha = 0.82f), CircleShape)
                .clickable(enabled = !busy && !recording, onClick = onRealtimeClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (streaming) Icons.Default.Stop else Icons.Default.Mic,
                contentDescription = if (streaming) "停止实时识别" else "开始实时识别",
                tint = Color.White,
                modifier = Modifier.size(if (compact) 30.dp else 36.dp),
            )
        }
        Text(
            primaryActionLabel(state),
            modifier = Modifier.padding(top = if (compact) 5.dp else 8.dp),
            color = Indigo,
            fontSize = if (compact) 12.sp else 14.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        FlowRow(
            modifier = Modifier.padding(top = if (compact) 4.dp else 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            TextButton(
                onClick = onRecordClick,
                enabled = !streaming && !busy,
                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
            ) {
                Icon(if (recording) Icons.Default.Stop else Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(3.dp))
                Text(if (recording) "结束录音" else "录音转写", fontSize = 11.sp, maxLines = 1)
            }
            if (state.currentTaskId != null) {
                TextButton(
                    onClick = onCancelClick,
                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
                ) {
                    Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(15.dp))
                    Spacer(Modifier.width(3.dp))
                    Text("取消", fontSize = 11.sp, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun HomeControlDeck(
    state: AppUiState,
    compact: Boolean,
    veryCompact: Boolean,
    onMicClick: () -> Unit,
) {
    val busy = state.status in setOf(WorkStatus.Checking, WorkStatus.Uploading, WorkStatus.Polling, WorkStatus.Processing)
    val listening = state.status == WorkStatus.Streaming
    val controlHeight = when {
        veryCompact -> 104.dp
        compact -> 126.dp
        else -> 156.dp
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(controlHeight),
    ) {
        if (!veryCompact) {
            RecognitionStatusCard(
                state = state,
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .width(if (compact) 152.dp else 164.dp),
                compact = compact,
            )
        }
        val micButtonSize = when {
            veryCompact -> 68.dp
            compact -> 76.dp
            else -> 86.dp
        }
        MicHero(
            listening = listening,
            busy = busy,
            statusText = when (state.status) {
                WorkStatus.Streaming -> "正在聆听中..."
                WorkStatus.Recording -> "录音中"
                WorkStatus.Processing, WorkStatus.Uploading, WorkStatus.Polling -> state.statusMessage
                else -> "点击开始识别"
            },
            onMicClick = onMicClick,
            height = controlHeight,
            buttonSize = micButtonSize,
            compact = compact,
            modifier = Modifier
                .align(Alignment.Center)
                .width(if (compact) 136.dp else 156.dp),
        )
        AssistantImage(
            resId = assistantResourceForStatus(state.status),
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .offset(x = if (compact) 20.dp else 18.dp, y = if (compact) 8.dp else 10.dp)
                .size(width = if (compact) 104.dp else 132.dp, height = if (compact) 142.dp else 178.dp),
        )
        Surface(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = if (compact) 4.dp else 8.dp, end = 2.dp)
                .size(if (compact) 34.dp else 40.dp),
            shape = CircleShape,
            color = Color.White.copy(alpha = 0.74f),
            border = BorderStroke(1.dp, Color.White.copy(alpha = 0.9f)),
            shadowElevation = 5.dp,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text("♥", color = Violet, fontSize = if (compact) 17.sp else 20.sp, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
private fun RecognitionStatusCard(
    state: AppUiState,
    modifier: Modifier = Modifier,
    compact: Boolean,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(if (compact) 18.dp else 22.dp),
        color = Color.White.copy(alpha = 0.66f),
        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.9f)),
        shadowElevation = 8.dp,
    ) {
        Column(
            modifier = Modifier.padding(if (compact) 10.dp else 12.dp),
            verticalArrangement = Arrangement.spacedBy(if (compact) 7.dp else 10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Icon(Icons.Default.Info, contentDescription = null, tint = Indigo, modifier = Modifier.size(17.dp))
                Text("识别状态", color = Ink, fontWeight = FontWeight.Bold, fontSize = if (compact) 13.sp else 14.sp)
            }
            StatusMetric("已识别时长", if (state.status == WorkStatus.Idle) "00:00:00" else "00:02:36")
            StatusMetric("识别准确率", if (state.status == WorkStatus.Error) "--" else "98.7%")
            StatusMetric("当前语言", state.settings.defaultLanguage.ifBlank { "中文" })
        }
    }
}

@Composable
private fun StatusMetric(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = MutedInk, fontSize = 11.sp, maxLines = 1)
        Text(value, color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

private fun micForegroundPermissions(): Array<String> =
    buildList {
        add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }.toTypedArray()

@Composable
private fun HomeHeader(
    state: AppUiState,
    compact: Boolean = false,
    onModels: () -> Unit,
    onSettings: () -> Unit,
    onRefresh: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (compact) 1.dp else 4.dp)) {
            Text(
                "ASRAPP",
                color = Indigo,
                fontSize = if (compact) 30.sp else 40.sp,
                fontWeight = FontWeight.ExtraBold,
                letterSpacing = 0.sp,
            )
            Text(
                "智能语音识别助手",
                color = Color(0xFF59658B),
                fontSize = if (compact) 14.sp else 18.sp,
                fontWeight = FontWeight.Medium,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (state.serverConnected) Mint else Color(0xFFFF7A90)),
                )
                Text(
                    state.serverMessage,
                    color = if (state.serverConnected) Color(0xFF269A7E) else Color(0xFFBD4058),
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                IconButton(onClick = onRefresh, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.Refresh, contentDescription = "刷新", tint = MutedInk, modifier = Modifier.size(18.dp))
                }
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(if (compact) 6.dp else 12.dp)) {
            IconButton(
                onClick = onSettings,
                modifier = Modifier
                    .size(if (compact) 40.dp else 48.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.58f))
                    .border(1.dp, Color.White.copy(alpha = 0.82f), CircleShape),
            ) {
                Icon(Icons.Default.Settings, contentDescription = "设置", tint = Ink, modifier = Modifier.size(if (compact) 20.dp else 24.dp))
            }
            Surface(
                onClick = onModels,
                shape = RoundedCornerShape(if (compact) 18.dp else 22.dp),
                color = Color.White.copy(alpha = 0.76f),
                shadowElevation = 8.dp,
                border = BorderStroke(1.dp, Color.White.copy(alpha = 0.9f)),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = if (compact) 9.dp else 12.dp, vertical = if (compact) 7.dp else 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Icon(Icons.Default.Build, contentDescription = null, tint = Indigo, modifier = Modifier.size(if (compact) 16.dp else 18.dp))
                    Text(
                        "模型: ${selectedEngineLabel(state.settings)}",
                        modifier = Modifier.widthIn(max = if (compact) 92.dp else 142.dp),
                        color = Indigo,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = if (compact) 11.sp else 13.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

private fun selectedEngineLabel(settings: AppSettings): String =
    settings.offlineEngines.firstOrNull()?.ifBlank { null } ?: "fireredasr2"

@Composable
private fun MicHero(
    listening: Boolean,
    busy: Boolean,
    statusText: String,
    onMicClick: () -> Unit,
    height: androidx.compose.ui.unit.Dp = 260.dp,
    buttonSize: androidx.compose.ui.unit.Dp = 158.dp,
    compact: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val transition = rememberInfiniteTransition(label = "micPulse")
    val pulse by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = if (listening) 1300 else 2400),
            repeatMode = RepeatMode.Restart,
        ),
        label = "pulse",
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(height),
        contentAlignment = Alignment.Center,
    ) {
        AudioAura(pulse = pulse, active = listening)
        AudioWaveform(
            modifier = Modifier
                .fillMaxWidth()
                .height(if (compact) 52.dp else 64.dp),
            active = listening,
            pulse = pulse,
        )
        Box(
            modifier = Modifier
                .size(buttonSize)
                .clip(CircleShape)
                .background(
                    Brush.linearGradient(
                        listOf(Color(0xFF69D5FF), Color(0xFF5E76FF), Color(0xFF8A5CFF)),
                    ),
                )
                .border(3.dp, Color.White.copy(alpha = 0.72f), CircleShape)
                .clickable(enabled = !busy, onClick = onMicClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (listening) Icons.Default.Stop else Icons.Default.Mic,
                contentDescription = statusText,
                tint = Color.White,
                modifier = Modifier.size(buttonSize * 0.42f),
            )
        }
        Text(
            statusText,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = if (compact) 0.dp else 4.dp),
            color = Indigo,
            fontSize = if (compact) 14.sp else 16.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun AudioAura(pulse: Float, active: Boolean) {
    Canvas(Modifier.fillMaxSize()) {
        val center = Offset(size.width / 2f, size.height / 2f - 16.dp.toPx())
        val base = min(size.width, size.height) * 0.22f
        val glow = if (active) 1f else 0.58f
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color(0x885ED8FF), Color(0x555E76FF), Color.Transparent),
                center = center,
                radius = base * 2.1f,
            ),
            radius = base * 2.1f,
            center = center,
        )
        repeat(5) { index ->
            val progress = (pulse + index * 0.18f) % 1f
            val radius = base + (index * 28.dp.toPx()) + progress * 34.dp.toPx()
            drawCircle(
                color = Color.White.copy(alpha = (0.5f - progress * 0.32f) * glow),
                radius = radius,
                center = center,
                style = Stroke(width = (2.5f - progress).coerceAtLeast(1f).dp.toPx()),
            )
        }
        drawCircle(
            color = Violet.copy(alpha = 0.25f),
            radius = base * 1.65f,
            center = center,
            style = Stroke(width = 2.dp.toPx()),
        )
    }
}

@Composable
private fun AudioWaveform(modifier: Modifier = Modifier, active: Boolean, pulse: Float) {
    val bars = listOf(0.18f, 0.34f, 0.24f, 0.47f, 0.62f, 0.38f, 0.7f, 0.54f, 0.28f, 0.4f, 0.2f, 0.16f)
    Canvas(modifier) {
        val centerY = size.height / 2f
        val gap = size.width / (bars.size * 2.5f)
        val startLeft = size.width * 0.02f
        val startRight = size.width * 0.62f
        bars.forEachIndexed { index, base ->
            val lift = if (active) (sin((pulse * 6.28f) + index).toFloat() * 0.18f) else 0f
            val height = size.height * (base + lift).coerceIn(0.12f, 0.88f)
            val alpha = if (active) 0.72f else 0.36f
            listOf(startLeft + index * gap, startRight + index * gap).forEach { x ->
                drawLine(
                    brush = Brush.verticalGradient(listOf(SkyBlue.copy(alpha = alpha), Violet.copy(alpha = alpha))),
                    start = Offset(x, centerY - height / 2f),
                    end = Offset(x, centerY + height / 2f),
                    strokeWidth = 7.dp.toPx(),
                    cap = StrokeCap.Round,
                )
            }
        }
    }
}

@Composable
private fun TranscriptGlassCard(
    state: AppUiState,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val liveText = listOf(state.streamCommittedText.trim(), state.streamPartialText.trim())
        .filter { it.isNotBlank() }
        .joinToString("\n")
    val resultText = state.currentResult?.fullText?.trim().orEmpty()
    val text = liveText.ifBlank {
        resultText.ifBlank { "你好，欢迎使用 ASRAPP 语音识别系统。" }
    }
    val recognizing = state.status == WorkStatus.Streaming || state.status == WorkStatus.Recording
    val textSize = when {
        compact && text.length > 140 -> 15.sp
        compact && text.length > 70 -> 17.sp
        compact -> 19.sp
        text.length > 180 -> 16.sp
        text.length > 90 -> 19.sp
        else -> 23.sp
    }
    val textLineHeight = when {
        compact && text.length > 140 -> 21.sp
        compact && text.length > 70 -> 23.sp
        compact -> 26.sp
        text.length > 180 -> 23.sp
        text.length > 90 -> 27.sp
        else -> 33.sp
    }
    val transcriptScrollState = rememberScrollState()

    LaunchedEffect(text) {
        delay(80)
        transcriptScrollState.animateScrollTo(transcriptScrollState.maxValue)
    }

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = if (compact) 220.dp else 320.dp),
        shape = RoundedCornerShape(if (compact) 22.dp else 28.dp),
        color = Color.White.copy(alpha = 0.64f),
        shadowElevation = 10.dp,
        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.95f)),
    ) {
        Box(Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(
                        start = if (compact) 14.dp else 20.dp,
                        top = if (compact) 12.dp else 16.dp,
                        end = if (compact) 14.dp else 20.dp,
                        bottom = if (compact) 10.dp else 16.dp,
                    ),
                verticalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 12.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Icons.Default.GraphicEq, contentDescription = null, tint = Violet, modifier = Modifier.size(20.dp))
                        Text("实时识别", color = Color(0xFF6C73A1), fontWeight = FontWeight.SemiBold)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(
                            Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(if (recognizing) Violet else Color(0xFFC3C9E8)),
                        )
                        Text(if (recognizing) "识别中" else "待识别", color = Color(0xFF6C73A1), fontSize = 13.sp)
                    }
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .verticalScroll(transcriptScrollState),
                ) {
                    Text(
                        text,
                        color = Ink,
                        fontSize = textSize,
                        lineHeight = textLineHeight,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                if (!compact) {
                    AudioWaveform(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(34.dp),
                        active = recognizing,
                        pulse = if (recognizing) 0.6f else 0f,
                    )
                }
            }
            Text(
                "“",
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = 20.dp, bottom = 6.dp),
                color = Indigo.copy(alpha = 0.14f),
                fontSize = 72.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun AssistantImage(
    modifier: Modifier = Modifier,
    resId: Int = R.drawable.asr_assistant_calm,
) {
    Image(
        painter = painterResource(resId),
        contentDescription = "语音助手",
        modifier = modifier,
        contentScale = ContentScale.Fit,
    )
}

private fun assistantResourceForStatus(status: WorkStatus): Int =
    when (status) {
        WorkStatus.Streaming -> R.drawable.asr_assistant_focused
        WorkStatus.Recording -> R.drawable.asr_assistant_surprised
        WorkStatus.Done -> R.drawable.asr_assistant_happy
        WorkStatus.Error -> R.drawable.asr_assistant_surprised
        else -> R.drawable.asr_assistant_calm
    }

@Composable
private fun AssistantMascot(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val skin = Color(0xFFFFE4EA)
        val hair = Color(0xFFF4F8FF)
        val hairLine = Color(0xFFAAB8FF)
        val suit = Color(0xFFEAF0FF)
        val suitDark = Color(0xFF343D83)
        val eye = Color(0xFF5369E8)

        drawOval(color = Color.White.copy(alpha = 0.72f), topLeft = Offset(w * 0.2f, h * 0.05f), size = Size(w * 0.6f, h * 0.58f))
        drawOval(color = hair, topLeft = Offset(w * 0.16f, h * 0.02f), size = Size(w * 0.68f, h * 0.62f))
        drawOval(color = skin, topLeft = Offset(w * 0.28f, h * 0.18f), size = Size(w * 0.44f, h * 0.36f))
        drawCircle(color = Color(0x33FF7AAE), radius = w * 0.045f, center = Offset(w * 0.34f, h * 0.4f))
        drawCircle(color = Color(0x33FF7AAE), radius = w * 0.045f, center = Offset(w * 0.66f, h * 0.4f))
        drawOval(color = eye, topLeft = Offset(w * 0.37f, h * 0.31f), size = Size(w * 0.07f, h * 0.09f))
        drawOval(color = eye, topLeft = Offset(w * 0.57f, h * 0.31f), size = Size(w * 0.07f, h * 0.09f))
        drawArc(
            color = Color(0xFFBD5D8C),
            startAngle = 18f,
            sweepAngle = 144f,
            useCenter = false,
            topLeft = Offset(w * 0.43f, h * 0.38f),
            size = Size(w * 0.16f, h * 0.12f),
            style = Stroke(width = 1.5.dp.toPx(), cap = StrokeCap.Round),
        )

        val fringe = Path().apply {
            moveTo(w * 0.2f, h * 0.2f)
            cubicTo(w * 0.36f, h * 0.02f, w * 0.48f, h * 0.24f, w * 0.43f, h * 0.32f)
            cubicTo(w * 0.52f, h * 0.14f, w * 0.65f, h * 0.2f, w * 0.62f, h * 0.33f)
            cubicTo(w * 0.76f, h * 0.16f, w * 0.86f, h * 0.26f, w * 0.74f, h * 0.5f)
            lineTo(w * 0.2f, h * 0.5f)
            close()
        }
        drawPath(fringe, color = hair.copy(alpha = 0.95f), style = Fill)
        drawCircle(color = Color(0xFFB6C7FF), radius = w * 0.1f, center = Offset(w * 0.78f, h * 0.3f), style = Stroke(width = 5.dp.toPx()))
        drawLine(color = Color(0xFF8FA3FF), start = Offset(w * 0.72f, h * 0.35f), end = Offset(w * 0.64f, h * 0.5f), strokeWidth = 3.dp.toPx(), cap = StrokeCap.Round)

        val body = Path().apply {
            moveTo(w * 0.28f, h * 0.6f)
            cubicTo(w * 0.36f, h * 0.52f, w * 0.66f, h * 0.52f, w * 0.74f, h * 0.6f)
            lineTo(w * 0.9f, h)
            lineTo(w * 0.1f, h)
            close()
        }
        drawPath(body, color = suit)
        drawPath(body, color = Color.White.copy(alpha = 0.58f), style = Stroke(width = 2.dp.toPx()))
        drawLine(color = suitDark, start = Offset(w * 0.5f, h * 0.62f), end = Offset(w * 0.5f, h), strokeWidth = 6.dp.toPx(), cap = StrokeCap.Round)
        drawCircle(color = Indigo, radius = w * 0.085f, center = Offset(w * 0.2f, h * 0.78f))
        drawRoundRect(
            color = suitDark,
            topLeft = Offset(w * 0.12f, h * 0.73f),
            size = Size(w * 0.12f, h * 0.26f),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(10.dp.toPx(), 10.dp.toPx()),
        )
        drawLine(color = hairLine, start = Offset(w * 0.23f, h * 0.2f), end = Offset(w * 0.18f, h * 0.74f), strokeWidth = 1.5.dp.toPx(), cap = StrokeCap.Round)
        drawLine(color = hairLine, start = Offset(w * 0.76f, h * 0.2f), end = Offset(w * 0.82f, h * 0.78f), strokeWidth = 1.5.dp.toPx(), cap = StrokeCap.Round)
    }
}

@Composable
private fun FileUploadHero(busy: Boolean, message: String, onPick: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(24.dp),
        color = Color.White.copy(alpha = 0.96f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
        shadowElevation = 3.dp,
    ) {
        Row(
            modifier = Modifier.padding(18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(64.dp)
                    .clip(CircleShape)
                    .background(Color(0xFFEAF0FF)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Upload, contentDescription = null, tint = Indigo, modifier = Modifier.size(30.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("导入音频文件", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Text(
                    if (busy) message else "选择本地音频，上传后自动显示转写结果",
                    color = MutedInk,
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                )
            }
            Button(onClick = onPick, enabled = !busy) {
                Text("选择")
            }
        }
    }
}

@Composable
private fun StatusBlock(status: WorkStatus, message: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = Color.White.copy(alpha = 0.88f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (status in setOf(WorkStatus.Checking, WorkStatus.Uploading, WorkStatus.Polling, WorkStatus.Processing, WorkStatus.Streaming)) {
                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = Indigo)
            } else {
                Icon(
                    if (status == WorkStatus.Done) Icons.Default.CheckCircle else Icons.Default.PlayArrow,
                    contentDescription = null,
                    tint = if (status == WorkStatus.Error) MaterialTheme.colorScheme.error else Indigo,
                )
            }
            Text(message, color = Ink, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun EngineSummary(settings: AppSettings, models: List<ModelInfo>) {
    val loaded = models.filter { it.isLoaded }.map { it.engine }.toSet()
    val offlineEngines = settings.offlineEngines.ifEmpty { listOf("fireredasr2") }
    val partialEngines = settings.realtimeEngines.ifEmpty { listOf("sensevoice") }
    val finalEngine = offlineEngines.firstOrNull() ?: "fireredasr2"
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("识别设置", style = MaterialTheme.typography.titleMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            AssistChip(
                onClick = {},
                label = { Text("离线 ${offlineEngines.joinToString { loadedLabel(it, loaded) }}") },
            )
            AssistChip(
                onClick = {},
                label = { Text("蹦字 ${partialEngines.joinToString { loadedLabel(it, loaded) }}") },
            )
            AssistChip(
                onClick = {},
                label = { Text("句子整理 ${loadedLabel(finalEngine, loaded)}") },
            )
            AssistChip(onClick = {}, label = { Text("语言 ${settings.defaultLanguage.ifBlank { "auto" }}") })
        }
    }
}

private fun loadedLabel(engine: String, loaded: Set<String>): String =
    if (loaded.contains(engine)) "$engine 已加载" else engine

@Composable
private fun LiveStreamPanel(committedText: String, partialText: String) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("实时转录", style = MaterialTheme.typography.titleMedium)
        val visibleText = listOf(committedText.trim(), partialText.trim())
            .filter { it.isNotEmpty() }
            .joinToString("\n")
        if (visibleText.isBlank()) {
            Text(
                "等待语音",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Text(visibleText, style = MaterialTheme.typography.bodyLarge)
        }
        if (partialText.isNotBlank()) {
            Text(
                "临时结果",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun ResultPanel(item: HistoryItem?) {
    val context = LocalContext.current
    if (item == null) {
        Box(
            modifier = Modifier.fillMaxWidth().height(220.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("选择音频或录音后，识别结果会显示在这里")
        }
        return
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(item.filename, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(item.engineUsed, item.language, item.confidence?.let { "置信度 %.2f".format(it) }).joinToString(" / "),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            IconButton(onClick = { copyText(context, item.fullText) }) {
                Icon(Icons.Default.ContentCopy, contentDescription = "复制")
            }
            IconButton(onClick = { AudioPreviewPlayer.toggle(context, item) }, enabled = item.hasPlayableAudio()) {
                Icon(
                    if (AudioPreviewPlayer.isCurrentPlaying(item)) Icons.Default.Pause else Icons.Default.PlayArrow,
                    contentDescription = "播放暂停",
                )
            }
            IconButton(onClick = { shareText(context, item.fullText) }) {
                Icon(Icons.Default.Share, contentDescription = "分享")
            }
        }
        item.category?.let {
            AssistChip(onClick = {}, label = { Text(it) })
        }
        AudioPlayerPanel(item, showSelection = true)
        Text(item.fullText, style = MaterialTheme.typography.bodyLarge)
        EngineResultsBlock(item)
        if (item.segments.isNotEmpty()) {
            Text("分段", style = MaterialTheme.typography.titleSmall)
            item.segments.forEach { SegmentRow(it) }
        }
    }
}

@Composable
private fun SegmentRow(segment: TranscriptSegment) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(
            "${formatSeconds(segment.start)} - ${formatSeconds(segment.end)}" +
                (segment.speaker?.let { " / $it" } ?: ""),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(segment.text)
    }
}

@Composable
private fun SummaryPage(viewModel: MainViewModel) {
    val state = viewModel.uiState
    val context = LocalContext.current
    var settings by remember(state.settings) { mutableStateOf(prefillSummaryTimeRange(state.settings)) }
    var activeTab by rememberSaveable { mutableStateOf("active") }
    var selectedRange by remember(settings.passiveSummaryStartTime, settings.passiveSummaryEndTime) {
        mutableStateOf(summaryRangeFromSettings(settings))
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, top = 14.dp, end = 16.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            TopStatusBar(
                state = state,
                onModels = { viewModel.selectPage(AppPage.Models) },
                onSettings = { viewModel.selectPage(AppPage.Settings) },
                onRefresh = { viewModel.checkServer(); viewModel.refreshModels() },
            )
        }
        item {
            SectionHeader("总结") {
                OutlinedButton(onClick = { viewModel.selectPage(AppPage.Models) }) {
                    Text("模型管理")
                }
            }
        }
        item {
            SummaryModeTabs(activeTab = activeTab, onSelect = { activeTab = it })
        }
        if (activeTab == "active") {
            item {
                ActiveSummaryControls(
                    settings = settings,
                    selectedRange = selectedRange,
                    onSettingsChange = { settings = it },
                    onRangeChange = { start, end ->
                        val range = start.toFloat()..end.toFloat()
                        selectedRange = range
                        settings = settings.copy(
                            passiveSummaryStartTime = minutesToClock(start),
                            passiveSummaryEndTime = minutesToClock(end),
                        )
                    },
                    onRun = {
                        viewModel.updateSettings(settings)
                        viewModel.runDailySummary()
                    },
                    message = state.summaryMessage,
                )
            }
            item {
                SummaryResultCard(
                    summary = state.dailySummary,
                    onCopy = { state.dailySummary?.summary?.let { copyText(context, it) } },
                    onShare = { state.dailySummary?.summary?.let { shareText(context, it) } },
                    onCloudSave = viewModel::saveDailySummaryCloud,
                )
            }
        } else {
            item {
                PassiveSummaryControls(
                    settings = settings,
                    onSettingsChange = { settings = it },
                    onSave = {
                        viewModel.updateSettings(settings)
                    },
                    message = state.summaryMessage,
                )
            }
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun SummaryModeTabs(activeTab: String, onSelect: (String) -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = Color.White.copy(alpha = 0.92f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
    ) {
        Row(
            modifier = Modifier.padding(6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SummaryTabButton(
                label = "主动总结",
                selected = activeTab == "active",
                modifier = Modifier.weight(1f),
                onClick = { onSelect("active") },
            )
            SummaryTabButton(
                label = "被动总结",
                selected = activeTab == "passive",
                modifier = Modifier.weight(1f),
                onClick = { onSelect("passive") },
            )
        }
    }
}

@Composable
private fun SummaryTabButton(label: String, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    Surface(
        onClick = onClick,
        modifier = modifier,
        shape = shape,
        color = if (selected) Indigo else Color.Transparent,
    ) {
        Text(
            label,
            modifier = Modifier.padding(vertical = 10.dp),
            color = if (selected) Color.White else MutedInk,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun ActiveSummaryControls(
    settings: AppSettings,
    selectedRange: ClosedFloatingPointRange<Float>,
    onSettingsChange: (AppSettings) -> Unit,
    onRangeChange: (Int, Int) -> Unit,
    onRun: () -> Unit,
    message: String,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(22.dp),
        color = Color.White.copy(alpha = 0.96f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
        shadowElevation = 2.dp,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("主动总结", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            OutlinedTextField(
                value = settings.llmStyle,
                onValueChange = { onSettingsChange(settings.copy(llmStyle = it)) },
                label = { Text("Prompt") },
                placeholder = { Text("我在 xx 说了啥来着？") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 2,
                maxLines = 4,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = settings.passiveSummaryUserId,
                    onValueChange = { onSettingsChange(settings.copy(passiveSummaryUserId = it)) },
                    label = { Text("用户") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = settings.passiveSummaryCategory,
                    onValueChange = { onSettingsChange(settings.copy(passiveSummaryCategory = it)) },
                    label = { Text("类别") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                )
            }
            DateTimeWheelRangeSelector(
                range = selectedRange,
                onRangeChange = onRangeChange,
            )
            Button(onClick = onRun, modifier = Modifier.fillMaxWidth()) {
                Text("开始总结")
            }
            Text(
                message.ifBlank { "Prompt 会作为本次总结的第一段指令，后面接时间戳 ASR 文本。" },
                color = MutedInk,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun PassiveSummaryControls(
    settings: AppSettings,
    onSettingsChange: (AppSettings) -> Unit,
    onSave: () -> Unit,
    message: String,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(22.dp),
        color = Color.White.copy(alpha = 0.96f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
        shadowElevation = 2.dp,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("被动总结设置", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            SettingSwitch("启用被动总结", settings.passiveSummaryEnabled) {
                onSettingsChange(settings.copy(passiveSummaryEnabled = it))
            }
            OutlinedTextField(
                value = settings.passiveSummaryFrequencyMin.toString(),
                onValueChange = { value ->
                    onSettingsChange(settings.copy(passiveSummaryFrequencyMin = value.filter(Char::isDigit).toIntOrNull() ?: 60))
                },
                label = { Text("自动总结频率（分钟）") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = settings.passiveSummaryUserId,
                    onValueChange = { onSettingsChange(settings.copy(passiveSummaryUserId = it)) },
                    label = { Text("用户") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = settings.passiveSummaryCategory,
                    onValueChange = { onSettingsChange(settings.copy(passiveSummaryCategory = it)) },
                    label = { Text("类别") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                )
            }
            SettingSwitch("总结后云端保存", settings.passiveSummaryAutoCloudSave) {
                onSettingsChange(settings.copy(passiveSummaryAutoCloudSave = it))
            }
            Button(onClick = onSave, modifier = Modifier.fillMaxWidth()) {
                Text("保存被动总结设置")
            }
            Text(
                message.ifBlank { "被动总结只在后台按频率运行；主动总结不会受此开关影响。" },
                color = MutedInk,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun DateTimeWheelRangeSelector(
    range: ClosedFloatingPointRange<Float>,
    onRangeChange: (Int, Int) -> Unit,
) {
    val start = range.start.roundToInt().coerceIn(0, 1439)
    val end = range.endInclusive.roundToInt().coerceIn(start, 1439)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("时间范围", color = Ink, fontWeight = FontWeight.SemiBold)
        TimeWheelPicker(
            title = "开始",
            minutes = start,
            onMinutesChange = { onRangeChange(it.coerceAtMost(end), end) },
        )
        TimeWheelPicker(
            title = "结束",
            minutes = end,
            onMinutesChange = { onRangeChange(start, it.coerceAtLeast(start)) },
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val now = currentMinuteOfDay()
            SummaryQuickChip("今天 0 点到现在") { onRangeChange(0, now) }
            SummaryQuickChip("30分钟") { onRangeChange(max(0, now - 30), now) }
            SummaryQuickChip("1小时") { onRangeChange(max(0, now - 60), now) }
            SummaryQuickChip("全天") { onRangeChange(0, 23 * 60 + 59) }
        }
    }
}

@Composable
private fun TimeWheelPicker(title: String, minutes: Int, onMinutesChange: (Int) -> Unit) {
    val hour = (minutes / 60).coerceIn(0, 23)
    val minute = (minutes % 60).coerceIn(0, 59)
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = Color(0xFFF7F9FF),
        border = BorderStroke(1.dp, Color(0xFFE2E8F8)),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(title, color = Ink, fontWeight = FontWeight.Bold)
                Text("今天 ${minutesToClock(minutes)}", color = Indigo, fontWeight = FontWeight.SemiBold)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                WheelColumn(
                    label = "日",
                    options = listOf("今天"),
                    selected = "今天",
                    modifier = Modifier.weight(1f),
                    onSelect = {},
                )
                WheelColumn(
                    label = "时",
                    options = (0..23).map { "%02d".format(Locale.US, it) },
                    selected = "%02d".format(Locale.US, hour),
                    modifier = Modifier.weight(1f),
                    onSelect = { selected -> onMinutesChange((selected.toIntOrNull() ?: hour) * 60 + minute) },
                )
                WheelColumn(
                    label = "分",
                    options = (0..59).map { "%02d".format(Locale.US, it) },
                    selected = "%02d".format(Locale.US, minute),
                    modifier = Modifier.weight(1f),
                    onSelect = { selected -> onMinutesChange(hour * 60 + (selected.toIntOrNull() ?: minute)) },
                )
            }
        }
    }
}

@Composable
private fun WheelColumn(
    label: String,
    options: List<String>,
    selected: String,
    modifier: Modifier = Modifier,
    onSelect: (String) -> Unit,
) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, color = MutedInk, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .height(116.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            items(options) { option ->
                Surface(
                    onClick = { onSelect(option) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp),
                    color = if (option == selected) Indigo.copy(alpha = 0.12f) else Color.Transparent,
                    border = if (option == selected) BorderStroke(1.dp, Indigo.copy(alpha = 0.42f)) else null,
                ) {
                    Text(
                        option,
                        modifier = Modifier.padding(vertical = 8.dp),
                        color = if (option == selected) Indigo else Ink,
                        fontWeight = if (option == selected) FontWeight.Bold else FontWeight.Medium,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}
@Composable
private fun SummaryQuickChip(label: String, onClick: () -> Unit) {
    AssistChip(onClick = onClick, label = { Text(label) })
}

private fun prefillSummaryTimeRange(settings: AppSettings): AppSettings {
    if (settings.passiveSummaryStartTime.isNotBlank() && settings.passiveSummaryEndTime.isNotBlank()) {
        return settings
    }
    val now = currentMinuteOfDay()
    return settings.copy(
        passiveSummaryStartTime = minutesToClock(0),
        passiveSummaryEndTime = minutesToClock(now),
    )
}

private fun summaryRangeFromSettings(settings: AppSettings): ClosedFloatingPointRange<Float> {
    val now = currentMinuteOfDay()
    val start = clockToMinutes(settings.passiveSummaryStartTime) ?: 0
    val end = clockToMinutes(settings.passiveSummaryEndTime) ?: now
    return normalizeMinuteRange(start.toFloat()..end.toFloat())
}

private fun normalizeMinuteRange(range: ClosedFloatingPointRange<Float>): ClosedFloatingPointRange<Float> {
    val start = range.start.roundToInt().coerceIn(0, 1439)
    val end = range.endInclusive.roundToInt().coerceIn(0, 1439)
    val normalizedEnd = max(start, end)
    return start.toFloat()..normalizedEnd.toFloat()
}

private fun currentMinuteOfDay(): Int {
    val parts = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date()).split(":")
    val hour = parts.getOrNull(0)?.toIntOrNull() ?: 0
    val minute = parts.getOrNull(1)?.toIntOrNull() ?: 0
    return (hour * 60 + minute).coerceIn(0, 1439)
}

private fun minutesToClock(minutes: Int): String {
    val clamped = minutes.coerceIn(0, 1439)
    return "%02d:%02d".format(Locale.US, clamped / 60, clamped % 60)
}

private fun clockToMinutes(value: String): Int? {
    val parts = value.split(":")
    val hour = parts.getOrNull(0)?.toIntOrNull() ?: return null
    val minute = parts.getOrNull(1)?.toIntOrNull() ?: return null
    if (hour !in 0..23 || minute !in 0..59) return null
    return hour * 60 + minute
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun SummaryResultCard(
    summary: ArchiveSummaryResult?,
    onCopy: () -> Unit,
    onShare: () -> Unit,
    onCloudSave: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(22.dp),
        color = Color.White.copy(alpha = 0.96f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
        shadowElevation = 2.dp,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("总结结果", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    Text(summary?.timeRange ?: "等待生成", color = MutedInk, fontSize = 12.sp)
                }
                IconButton(onClick = onCopy, enabled = summary != null) {
                    Icon(Icons.Default.ContentCopy, contentDescription = "复制")
                }
                IconButton(onClick = onShare, enabled = summary != null) {
                    Icon(Icons.Default.Share, contentDescription = "分享")
                }
                OutlinedButton(onClick = onCloudSave, enabled = summary != null) {
                    Text("云端")
                }
            }
            if (summary == null) {
                EmptyState("还没有总结。")
            } else {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(onClick = {}, label = { Text("记录 ${summary.sourceCount}") })
                    AssistChip(onClick = {}, label = { Text("输入 ${summary.estimatedInputTokens}") })
                    AssistChip(onClick = {}, label = { Text("分块 ${summary.chunkCount}") })
                    if (summary.truncated) AssistChip(onClick = {}, label = { Text("已截断") })
                }
                Text(
                    summary.summary,
                    color = Ink,
                    fontSize = 14.sp,
                    lineHeight = 22.sp,
                )
            }
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun ModelsPage(viewModel: MainViewModel) {
    val state = viewModel.uiState
    var configFor by remember { mutableStateOf<ModelInfo?>(null) }
    var language by remember(state.settings.defaultLanguage) { mutableStateOf(state.settings.defaultLanguage) }
    var whisperModel by remember(state.settings.whisperModel) { mutableStateOf(state.settings.whisperModel) }
    var punctuation by remember(state.settings.enablePunctuation) { mutableStateOf(state.settings.enablePunctuation) }
    var diarize by remember(state.settings.enableDiarize) { mutableStateOf(state.settings.enableDiarize) }
    var llmProvider by remember(state.settings.llmProvider) { mutableStateOf(state.settings.llmProvider) }
    var llmBaseUrl by remember(state.settings.llmBaseUrl) { mutableStateOf(state.settings.llmBaseUrl) }
    var llmModel by remember(state.settings.llmModel) { mutableStateOf(state.settings.llmModel) }
    var llmToken by remember(state.settings.llmApiToken) { mutableStateOf(state.settings.llmApiToken) }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, top = 14.dp, end = 16.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            TopStatusBar(
                state = state,
                onModels = { viewModel.selectPage(AppPage.Models) },
                onSettings = { viewModel.selectPage(AppPage.Settings) },
                onRefresh = { viewModel.checkServer(); viewModel.refreshModels() },
            )
        }
        item {
            SectionHeader("模型管理") {
                IconButton(onClick = viewModel::refreshModels) {
                    Icon(Icons.Default.Refresh, contentDescription = "刷新模型")
                }
            }
        }
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(22.dp),
                color = Color.White.copy(alpha = 0.96f),
                border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
                shadowElevation = 2.dp,
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("识别偏好", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                OutlinedTextField(
                    value = language,
                    onValueChange = { language = it },
                    label = { Text("语言代码") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = whisperModel,
                    onValueChange = { whisperModel = it },
                    label = { Text("Whisper 转写模型") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                SettingSwitch("恢复标点", punctuation) { punctuation = it }
                SettingSwitch("说话人区分", diarize) { diarize = it }
                Button(
                    onClick = {
                        viewModel.updateModelRecognitionConfig(
                            language = language,
                            whisperModel = whisperModel,
                            enablePunctuation = punctuation,
                            enableDiarize = diarize,
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("保存识别选项")
                }
                }
            }
        }
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(22.dp),
                color = Color.White.copy(alpha = 0.96f),
                border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
                shadowElevation = 2.dp,
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("大模型设置", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    OutlinedTextField(
                        value = llmProvider,
                        onValueChange = { value ->
                            llmProvider = value
                            if (value == "deepseek") llmBaseUrl = "https://api.deepseek.com"
                        },
                        label = { Text("厂商") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = llmBaseUrl,
                        onValueChange = { llmBaseUrl = it },
                        label = { Text("官方地址") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = llmToken,
                        onValueChange = { llmToken = it },
                        label = { Text("API Token") },
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = llmModel,
                        onValueChange = { llmModel = it },
                        label = { Text("模型") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Button(
                            onClick = {
                                viewModel.updateSettings(
                                    state.settings.copy(
                                        llmProvider = llmProvider,
                                        llmBaseUrl = llmBaseUrl,
                                        llmModel = llmModel,
                                        llmApiToken = llmToken,
                                    )
                                )
                                viewModel.checkLlmModels()
                            },
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("连接并列出模型")
                        }
                        StatusPill(if (state.llmConnected) "连接成功" else state.llmMessage)
                    }
                    if (state.llmModels.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            state.llmModels.forEach { model ->
                                AssistChip(
                                    onClick = {
                                        llmModel = model
                                        viewModel.updateSettings(state.settings.copy(llmModel = model))
                                    },
                                    label = { Text(model, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                )
                            }
                        }
                    }
                }
            }
        }
        if (state.models.isEmpty()) {
            item {
                EmptyState("暂无模型数据，请确认后端已启动并可访问。")
            }
        } else {
            items(state.models, key = { it.engine }) { model ->
                ModelCard(
                    model = model,
                    offlineSelected = state.settings.offlineEngines.contains(model.engine),
                    realtimeSelected = state.settings.realtimeEngines.contains(model.engine),
                    onOfflineSelect = { viewModel.selectOfflineEngine(model.engine) },
                    onRealtimeSelect = { viewModel.selectRealtimeEngine(model.engine) },
                    onLoad = { configFor = model },
                    onUnload = { viewModel.unloadModel(model.engine) },
                )
            }
        }
    }

    configFor?.let { model ->
        LoadModelDialog(
            model = model,
            onDismiss = { configFor = null },
            onLoad = { modelName, device, computeType ->
                configFor = null
                viewModel.loadModel(model.engine, modelName, device, computeType)
            },
        )
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun ModelCard(
    model: ModelInfo,
    offlineSelected: Boolean,
    realtimeSelected: Boolean,
    onOfflineSelect: () -> Unit,
    onRealtimeSelect: () -> Unit,
    onLoad: () -> Unit,
    onUnload: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = Color.White.copy(alpha = 0.96f),
        border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
        shadowElevation = 2.dp,
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(model.engine, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    Text(model.modelName, color = MutedInk, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                StatusPill(if (model.isLoaded) "已加载" else "未加载")
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = offlineSelected, onClick = onOfflineSelect)
                    Text("离线识别", color = Ink, fontSize = 13.sp)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = realtimeSelected, onClick = onRealtimeSelect)
                    Text("实时识别", color = Ink, fontSize = 13.sp)
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                model.device?.let { AssistChip(onClick = {}, label = { Text(it) }) }
                model.computeType?.let { AssistChip(onClick = {}, label = { Text(it) }) }
                model.languages.take(4).forEach { AssistChip(onClick = {}, label = { Text(it) }) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onLoad) { Text("加载") }
                OutlinedButton(onClick = onUnload, enabled = model.isLoaded) { Text("卸载") }
            }
        }
    }
}

@Composable
private fun LoadModelDialog(
    model: ModelInfo,
    onDismiss: () -> Unit,
    onLoad: (String?, String?, String?) -> Unit,
) {
    var modelName by rememberSaveable(model.engine) { mutableStateOf(defaultModelName(model.engine, model.modelName)) }
    var device by rememberSaveable(model.engine) { mutableStateOf(model.device ?: "cuda") }
    var computeType by rememberSaveable(model.engine) { mutableStateOf(model.computeType ?: if (model.engine == "whisper") "int8" else "") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("加载 ${model.engine}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(modelName, { modelName = it }, label = { Text("模型名") }, singleLine = true)
                OutlinedTextField(device, { device = it }, label = { Text("设备 cpu/cuda") }, singleLine = true)
                OutlinedTextField(computeType, { computeType = it }, label = { Text("计算类型") }, singleLine = true)
            }
        },
        confirmButton = {
            Button(onClick = { onLoad(modelName, device, computeType) }) {
                Text("加载")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun HistoryPage(viewModel: MainViewModel) {
    val state = viewModel.uiState
    val context = LocalContext.current
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, top = 14.dp, end = 16.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            TopStatusBar(
                state = state,
                onModels = { viewModel.selectPage(AppPage.Models) },
                onSettings = { viewModel.selectPage(AppPage.Settings) },
                onRefresh = { viewModel.checkServer(); viewModel.refreshModels() },
            )
        }
        item {
            SectionHeader("历史记录") {
                TextButton(onClick = viewModel::clearHistory, enabled = state.history.isNotEmpty()) {
                    Text("清空")
                }
            }
        }
        if (state.history.isEmpty()) {
            item { EmptyState("暂无历史记录。完成一次实时识别或录音转写后会出现在这里。") }
        } else {
            items(state.history, key = { it.taskId }) { item ->
                Surface(
                    onClick = { viewModel.showHistory(item) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(20.dp),
                    color = Color.White.copy(alpha = 0.96f),
                    border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
                    shadowElevation = 2.dp,
                ) {
                    Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(item.filename, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(formatTime(item.createdAt), color = MutedInk, fontSize = 12.sp)
                            }
                            IconButton(onClick = { copyText(context, item.fullText) }) {
                                Icon(Icons.Default.ContentCopy, contentDescription = "复制")
                            }
                            IconButton(onClick = { AudioPreviewPlayer.toggle(context, item) }, enabled = item.hasPlayableAudio()) {
                                Icon(
                                    if (AudioPreviewPlayer.isCurrentPlaying(item)) Icons.Default.Pause else Icons.Default.PlayArrow,
                                    contentDescription = "播放暂停",
                                )
                            }
                            IconButton(onClick = { shareText(context, exportText(item)) }) {
                                Icon(Icons.Default.Share, contentDescription = "分享")
                            }
                            IconButton(onClick = { viewModel.deleteHistory(item) }) {
                                Icon(Icons.Default.Delete, contentDescription = "删除")
                            }
                        }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            item.category?.let { AssistChip(onClick = {}, label = { Text(it) }) }
                            item.resultKind?.let { AssistChip(onClick = {}, label = { Text(it) }) }
                            if (item.hasPlayableAudio()) {
                                AssistChip(onClick = {}, label = { Text("可播放音频") })
                            }
                        }
                        Text(item.fullText, color = Ink, fontSize = 14.sp, lineHeight = 21.sp, maxLines = 5, overflow = TextOverflow.Ellipsis)
                        if (AudioPreviewPlayer.isCurrent(item)) {
                            AudioPlayerPanel(item, showSelection = false)
                        }
                        EngineResultsBlock(item)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun SettingsPage(viewModel: MainViewModel) {
    val state = viewModel.uiState
    val context = LocalContext.current
    var settings by remember(state.settings) { mutableStateOf(state.settings) }
    var deviceRefreshKey by remember { mutableStateOf(0) }
    val audioInputs = remember(deviceRefreshKey, settings.audioInputDeviceKey) { audioInputOptions(context) }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    Box(Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, top = 14.dp, end = 16.dp, bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            TopStatusBar(
                state = state,
                onModels = { viewModel.selectPage(AppPage.Models) },
                onSettings = { viewModel.selectPage(AppPage.Settings) },
                onRefresh = { viewModel.checkServer(); viewModel.refreshModels() },
            )
            SectionHeader("我的")
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(22.dp),
                color = Color.White.copy(alpha = 0.96f),
                border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
                shadowElevation = 2.dp,
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("连接", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    OutlinedTextField(
                        value = settings.serverUrl,
                        onValueChange = { settings = settings.copy(serverUrl = it) },
                        label = { Text("后端地址") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = settings.streamUserId,
                        onValueChange = { settings = settings.copy(streamUserId = it) },
                        label = { Text("用户标识") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                }
            }
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(22.dp),
                color = Color.White.copy(alpha = 0.96f),
                border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
                shadowElevation = 2.dp,
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("识别偏好", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("模型管理", color = Ink, fontWeight = FontWeight.SemiBold)
                            Text(selectedEngineLabel(settings), color = MutedInk, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        OutlinedButton(onClick = { viewModel.selectPage(AppPage.Models) }) {
                            Text("打开")
                        }
                    }
                    SettingSwitch("恢复标点", settings.enablePunctuation) {
                        settings = settings.copy(enablePunctuation = it)
                    }
                    SettingSwitch("说话人区分", settings.enableDiarize) {
                        settings = settings.copy(enableDiarize = it)
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("输入设备", color = Ink, fontWeight = FontWeight.SemiBold)
                            Text(
                                audioInputs.firstOrNull { it.key == settings.audioInputDeviceKey }?.label ?: "跟随系统",
                                color = MutedInk,
                                fontSize = 12.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        TextButton(onClick = { deviceRefreshKey += 1 }) {
                            Text("刷新")
                        }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        audioInputs.forEach { option ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                RadioButton(
                                    selected = settings.audioInputDeviceKey == option.key,
                                    onClick = { settings = settings.copy(audioInputDeviceKey = option.key) },
                                )
                                Text(option.label, color = Ink, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    OutlinedTextField(
                        value = settings.timeoutSec.toString(),
                        onValueChange = { value ->
                            settings = settings.copy(timeoutSec = value.filter(Char::isDigit).toIntOrNull() ?: 0)
                        },
                        label = { Text("任务超时秒数，0 表示不限制") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                }
            }
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(22.dp),
                color = Color.White.copy(alpha = 0.96f),
                border = BorderStroke(1.dp, Color(0xFFE0E8F6)),
                shadowElevation = 2.dp,
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("隐私与存储", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    SettingSwitch("上传到后端保存", settings.allowServerDataCollection) {
                        settings = settings.copy(allowServerDataCollection = it)
                    }
                }
            }
            Button(
                onClick = {
                    viewModel.updateSettings(settings)
                    viewModel.checkServer()
                    scope.launch { snackbar.showSnackbar("设置已保存") }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("保存设置")
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label)
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

private data class AudioInputOption(val key: String, val label: String)

private fun audioInputOptions(context: Context): List<AudioInputOption> {
    val system = AudioInputOption("", "跟随系统")
    val audioManager = context.getSystemService(AudioManager::class.java) ?: return listOf(system)
    val devices = runCatching {
        audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .filter { it.isSource && it.isSupportedInputForUi() }
            .map { device -> AudioInputOption(AudioRouteController.keyFor(device), AudioRouteController.label(device)) }
            .distinctBy { it.key }
    }.getOrDefault(emptyList())
    return listOf(system) + devices
}

private fun AudioDeviceInfo.isSupportedInputForUi(): Boolean =
    type == AudioDeviceInfo.TYPE_BUILTIN_MIC ||
        type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
        type == AudioDeviceInfo.TYPE_USB_HEADSET ||
        type == AudioDeviceInfo.TYPE_USB_DEVICE ||
        type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET)

private fun copyText(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("ASR", text))
}

private fun shareText(context: Context, text: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(intent, "分享识别结果"))
}

private fun exportText(item: HistoryItem): String =
    buildString {
        appendLine(item.filename)
        appendLine(formatTime(item.createdAt))
        appendLine()
        appendLine(item.fullText)
        if (item.segments.isNotEmpty()) {
            appendLine()
            item.segments.forEach { segment ->
                appendLine("[${formatSeconds(segment.start)} - ${formatSeconds(segment.end)}] ${segment.text}")
            }
        }
    }

@Composable
private fun EngineResultsBlock(item: HistoryItem) {
    val results = item.engineResults.orEmpty()
    if (results.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("引擎结果", style = MaterialTheme.typography.titleSmall)
        results.forEach { result ->
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text(
                    listOfNotNull(result.engine, result.language, result.confidence?.let { "置信度 %.2f".format(it) }).joinToString(" / "),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(result.fullText)
            }
        }
    }
}

private fun HistoryItem.hasPlayableAudio(): Boolean =
    !audioUri.isNullOrBlank() || audioPath?.let { File(it).exists() } == true

@Composable
private fun AudioPlayerPanel(item: HistoryItem, showSelection: Boolean) {
    if (!item.hasPlayableAudio()) return
    val context = LocalContext.current
    LaunchedEffect(item.playbackKey()) {
        AudioPreviewPlayer.prepare(context, item)
    }

    val state = AudioPreviewPlayer.state
    LaunchedEffect(state.isPlaying, state.key) {
        while (state.isPlaying) {
            delay(200)
            AudioPreviewPlayer.refreshPosition()
        }
    }

    if (!AudioPreviewPlayer.isCurrent(item)) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            IconButton(onClick = { AudioPreviewPlayer.toggle(context, item) }) {
                Icon(
                    if (state.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                    contentDescription = "播放暂停",
                )
            }
            Text(
                "${formatMillis(state.positionMs)} / ${formatMillis(state.durationMs)}",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (state.durationMs > 0) {
            Slider(
                value = state.positionMs.coerceIn(0, state.durationMs).toFloat(),
                onValueChange = { AudioPreviewPlayer.seekTo(it.toInt()) },
                valueRange = 0f..state.durationMs.toFloat(),
            )
            if (showSelection) {
                RangeSlider(
                    value = state.selectionStartMs.toFloat()..state.selectionEndMs.toFloat(),
                    onValueChange = { range ->
                        AudioPreviewPlayer.setSelection(range.start.toInt(), range.endInclusive.toInt())
                    },
                    valueRange = 0f..state.durationMs.toFloat(),
                )
                Text(
                    "播放区间 ${formatMillis(state.selectionStartMs)} - ${formatMillis(state.selectionEndMs)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private data class AudioPlayerState(
    val key: String? = null,
    val durationMs: Int = 0,
    val positionMs: Int = 0,
    val selectionStartMs: Int = 0,
    val selectionEndMs: Int = 0,
    val isPlaying: Boolean = false,
)

private object AudioPreviewPlayer {
    private var player: MediaPlayer? = null
    private val handler = Handler(Looper.getMainLooper())
    private val stopAtSelectionEnd = Runnable {
        if (state.isPlaying) {
            refreshPosition()
        }
    }
    var state by mutableStateOf(AudioPlayerState())
        private set

    fun prepare(context: Context, item: HistoryItem, autoplay: Boolean = false) {
        val key = item.playbackKey()
        if (state.key == key && player != null) return
        release()
        val uri = item.audioUri() ?: return
        val next = MediaPlayer()
        runCatching {
            next.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            next.setDataSource(context, uri)
            next.setOnCompletionListener {
                state = state.copy(isPlaying = false, positionMs = state.selectionEndMs)
            }
            next.prepare()
            player = next
            val durationMs = next.duration.coerceAtLeast(0)
            val range = item.defaultPlaybackRangeMs(durationMs)
            next.seekTo(range.first)
            state = AudioPlayerState(
                key = key,
                durationMs = durationMs,
                positionMs = range.first,
                selectionStartMs = range.first,
                selectionEndMs = range.second,
                isPlaying = false,
            )
            if (autoplay) {
                startPrepared()
            }
        }.onFailure {
            next.release()
            state = AudioPlayerState()
        }
    }

    fun toggle(context: Context, item: HistoryItem) {
        if (state.key != item.playbackKey() || player == null) {
            prepare(context, item, autoplay = true)
            return
        }
        if (state.isPlaying) {
            pause()
        } else {
            startPrepared()
        }
    }

    fun seekTo(positionMs: Int) {
        val duration = state.durationMs.coerceAtLeast(0)
        val target = positionMs.coerceIn(0, duration)
        runCatching { player?.seekTo(target) }
        state = state.copy(positionMs = target)
        if (state.isPlaying && target >= state.selectionEndMs) {
            pause()
        } else if (state.isPlaying) {
            scheduleSelectionStop()
        }
    }

    fun setSelection(startMs: Int, endMs: Int) {
        if (state.durationMs <= 0) return
        val start = startMs.coerceIn(0, state.durationMs)
        val end = endMs.coerceIn(start, state.durationMs)
        state = state.copy(selectionStartMs = start, selectionEndMs = end)
        if (state.positionMs < start || state.positionMs > end) {
            seekTo(start)
        } else if (state.isPlaying && state.positionMs >= end) {
            pause()
        } else if (state.isPlaying) {
            scheduleSelectionStop()
        }
    }

    fun refreshPosition() {
        val current = runCatching { player?.currentPosition ?: state.positionMs }.getOrDefault(state.positionMs)
        if (state.isPlaying && current >= state.selectionEndMs) {
            runCatching { player?.pause() }
            runCatching { player?.seekTo(state.selectionEndMs) }
            handler.removeCallbacks(stopAtSelectionEnd)
            state = state.copy(isPlaying = false, positionMs = state.selectionEndMs)
            return
        }
        state = state.copy(positionMs = current.coerceIn(0, state.durationMs.coerceAtLeast(current)))
        if (state.isPlaying) {
            scheduleSelectionStop()
        }
    }

    fun isCurrent(item: HistoryItem): Boolean =
        state.key == item.playbackKey()

    fun isCurrentPlaying(item: HistoryItem): Boolean =
        isCurrent(item) && state.isPlaying

    private fun startPrepared() {
        val mediaPlayer = player ?: return
        val start = state.selectionStartMs
        val end = state.selectionEndMs.takeIf { it > start } ?: state.durationMs
        if (state.positionMs !in start until end) {
            runCatching { mediaPlayer.seekTo(start) }
            state = state.copy(positionMs = start)
        }
        runCatching { mediaPlayer.start() }
            .onSuccess {
                state = state.copy(isPlaying = true)
                scheduleSelectionStop()
            }
    }

    private fun pause() {
        handler.removeCallbacks(stopAtSelectionEnd)
        runCatching { player?.pause() }
        state = state.copy(isPlaying = false)
    }

    private fun release() {
        handler.removeCallbacks(stopAtSelectionEnd)
        runCatching { player?.stop() }
        player?.release()
        player = null
        state = AudioPlayerState()
    }

    private fun scheduleSelectionStop() {
        handler.removeCallbacks(stopAtSelectionEnd)
        val delayMs = (state.selectionEndMs - state.positionMs).coerceAtLeast(50)
        handler.postDelayed(stopAtSelectionEnd, delayMs.toLong())
    }
}

private fun HistoryItem.audioUri(): Uri? {
    val path = audioPath
    return when {
        !audioUri.isNullOrBlank() -> Uri.parse(audioUri)
        path != null && File(path).exists() -> Uri.fromFile(File(path))
        else -> null
    }
}

private fun HistoryItem.playbackKey(): String =
    listOf(taskId, audioPath.orEmpty(), audioUri.orEmpty(), playbackStartSec?.toString().orEmpty(), playbackEndSec?.toString().orEmpty())
        .joinToString("|")

private fun HistoryItem.defaultPlaybackRangeMs(durationMs: Int): Pair<Int, Int> {
    val start = ((playbackStartSec ?: 0.0) * 1000.0).toInt().coerceIn(0, durationMs.coerceAtLeast(0))
    val preferredEndSec = playbackEndSec ?: durationSec?.let { (playbackStartSec ?: 0.0) + it }
    val end = ((preferredEndSec ?: (durationMs / 1000.0)) * 1000.0)
        .toInt()
        .coerceIn(start, durationMs.coerceAtLeast(start))
    return start to if (end > start) end else durationMs.coerceAtLeast(start)
}

private fun defaultModelName(engine: String, fallback: String): String =
    when (engine) {
        "whisper" -> "base"
        "fireredasr2" -> "FireRedASR2-AED"
        "sensevoice" -> "SenseVoiceSmall"
        "qwen3asr" -> "Qwen/Qwen3-ASR-1.7B"
        "wenet" -> "FireRed-Wenet-1B"
        else -> fallback
    }

private fun formatTime(timeMillis: Long): String =
    SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(timeMillis))

private fun formatSeconds(seconds: Double): String {
    val total = seconds.toInt()
    val min = total / 60
    val sec = total % 60
    return "%02d:%02d".format(min, sec)
}

private fun formatMillis(milliseconds: Int): String =
    formatSeconds(milliseconds.coerceAtLeast(0) / 1000.0)
