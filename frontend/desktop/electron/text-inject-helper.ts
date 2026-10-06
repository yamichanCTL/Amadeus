/** Fixed explanations only; never display/log a UIAutomation element's name,
 * clipboard contents, or the upstream exception (which can contain text). */
export function textInjectionFailure(code?: string): string {
  switch (code) {
    case 'target-missing': return '自动填充未完成：原输入窗口已关闭或已更换。结果已保留，可点击复制。'
    case 'focus-not-restored': return '自动填充未完成：无法恢复原输入窗口的焦点。结果已保留，可点击复制。'
    case 'not-editable': return '自动填充未完成：原窗口当前没有可编辑的输入框。结果已保留，可点击复制。'
    case 'clipboard-busy': return '自动填充未完成：剪贴板正被其他软件占用。结果已保留，可点击复制。'
    case 'input-rejected': return '自动填充未完成：目标应用拒绝了模拟输入，请检查两者的运行权限。结果已保留，可点击复制。'
    case 'timeout': return '自动填充未确认：目标应用响应超时，为避免重复输入未再次粘贴。结果已保留，可点击复制。'
    default: return '自动填充未完成：请检查输入框的焦点和运行权限。结果已保留，可点击复制。'
  }
}

/** One prewarmed STA process handles foreground capture and clipboard/paste.
 * No window titles or edited text are included in diagnostic responses. */
export function textInjectHelperScript(): string {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$nativeCode = @'
using System;
using System.Runtime.InteropServices;
public static class AmadeusPaste {
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUT_UNION u; }
  static INPUT Key(ushort vk, bool up) { var value = new INPUT { type = 1 }; value.u.ki.wVk = vk; value.u.ki.dwFlags = up ? 2u : 0u; return value; }
  public static bool TargetAlive(long hwnd, uint expectedPid) {
    var handle = new IntPtr(hwnd); uint pid;
    return handle != IntPtr.Zero && expectedPid != 0 && IsWindow(handle) && GetWindowThreadProcessId(handle, out pid) != 0 && pid == expectedPid;
  }
  public static bool RestoreTarget(long hwnd, uint expectedPid) {
    if (!TargetAlive(hwnd, expectedPid)) return false;
    var handle = new IntPtr(hwnd);
    if (GetForegroundWindow() == handle) return true;
    if (IsIconic(handle)) ShowWindow(handle, 9);
    SetForegroundWindow(handle);
    return GetForegroundWindow() == handle;
  }
  public static bool HasTargetRoot(long nativeHandle, long targetHwnd) {
    return nativeHandle != 0 && GetAncestor(new IntPtr(nativeHandle), 2) == new IntPtr(targetHwnd);
  }
  public static bool SendCtrlV(long hwnd, uint expectedPid) {
    if (!TargetAlive(hwnd, expectedPid) || GetForegroundWindow() != new IntPtr(hwnd)) return false;
    // Explicit modifier releases handle Alt based triggers. One checked batch
    // avoids treating a UIPI-denied or partial sequence as successful delivery.
    var inputs = new INPUT[] { Key(0x12, true), Key(0x11, true), Key(0x10, true), Key(0x11, false), Key(0x56, false), Key(0x56, true), Key(0x11, true) };
    uint accepted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (accepted != inputs.Length) { var release = new INPUT[] { Key(0x11, true) }; SendInput(1, release, Marshal.SizeOf(typeof(INPUT))); return false; }
    return true;
  }
}
'@
Add-Type -TypeDefinition $nativeCode
function Respond($result) {
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress)); [Console]::Out.Flush()
}
function FocusBelongsToTarget($focused, $targetHwnd, $expectedPid) {
  $ancestor = $focused
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($depth = 0; $depth -lt 24 -and $null -ne $ancestor; $depth++) {
    $nativeHandle = $ancestor.Current.NativeWindowHandle
    if ($nativeHandle -ne 0) { return [AmadeusPaste]::HasTargetRoot($nativeHandle, $targetHwnd) }
    $ancestor = $walker.GetParent($ancestor)
  }
  # Chromium/Electron accessibility providers can belong to a renderer PID;
  # an ancestor native window proves membership without relaxing target identity.
  return ($focused.Current.ProcessId -eq $expectedPid)
}
function FocusEditable($targetHwnd, $expectedPid) {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $focused -or -not $focused.Current.IsEnabled -or -not (FocusBelongsToTarget $focused $targetHwnd $expectedPid)) { return $false }
  $value = $null
  if ($focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) { return -not $value.Current.IsReadOnly }
  $type = $focused.Current.ControlType
  # Custom/rich text editors may not expose ValuePattern. Require positive text
  # evidence; a process name alone never permits pasting into buttons or menus.
  if ($type -eq [System.Windows.Automation.ControlType]::Edit) { return $true }
  $caretPattern = $null
  if (($type -eq [System.Windows.Automation.ControlType]::Custom -or $type -eq [System.Windows.Automation.ControlType]::Document) -and $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern2]::Pattern, [ref]$caretPattern)) {
    $caretActive = $false
    $caret = $caretPattern.GetCaretRange([ref]$caretActive)
    return ($caretActive -and $null -ne $caret)
  }
  return $false
}
Respond @{ ready = $true }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $operation = ''
  $submitted = $false
  try {
    $request = $line | ConvertFrom-Json
    $operation = $request.operation
    if ($operation -eq 'capture') {
      $hwnd = [AmadeusPaste]::GetForegroundWindow()
      $windowPid = [uint32]0
      [void][AmadeusPaste]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
      Respond @{ operation = 'capture'; ok = ($hwnd -ne [IntPtr]::Zero -and $windowPid -ne 0); hwnd = $hwnd.ToInt64().ToString(); processId = $windowPid }
      continue
    }
    if ($operation -ne 'inject') { Respond @{ operation = $operation; ok = $false; code = 'target-missing' }; continue }
    $targetHwnd = [int64]$request.hwnd
    $targetPid = [uint32]$request.processId
    if (-not [AmadeusPaste]::TargetAlive($targetHwnd, $targetPid)) { Respond @{ operation = 'inject'; ok = $false; code = 'target-missing' }; continue }
    if (-not [AmadeusPaste]::RestoreTarget($targetHwnd, $targetPid)) { Respond @{ operation = 'inject'; ok = $false; code = 'focus-not-restored' }; continue }
    if (-not (FocusEditable $targetHwnd $targetPid)) { Respond @{ operation = 'inject'; ok = $false; code = 'not-editable' }; continue }
    $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($request.textBase64))
    if ([string]::IsNullOrWhiteSpace($text)) { Respond @{ operation = 'inject'; ok = $false; code = 'not-editable' }; continue }
    try {
      $data = New-Object System.Windows.Forms.DataObject
      $data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $true, $text)
      [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 3, 20)
    } catch { Respond @{ operation = 'inject'; ok = $false; code = 'clipboard-busy'; retryable = $true }; continue }
    # Verify again after the clipboard step. Users can change focus in between.
    if ([AmadeusPaste]::GetForegroundWindow().ToInt64() -ne $targetHwnd) { Respond @{ operation = 'inject'; ok = $false; code = 'focus-not-restored' }; continue }
    $submitted = $true
    $accepted = [AmadeusPaste]::SendCtrlV($targetHwnd, $targetPid)
    Respond @{ operation = 'inject'; ok = $accepted; code = $(if ($accepted) { '' } else { 'input-rejected' }) }
  } catch {
    # After attempting input, even a lost acknowledgement is never retried.
    Respond @{ operation = $operation; ok = $false; code = 'helper-error'; retryable = (-not $submitted) }
  }
}
`
}
