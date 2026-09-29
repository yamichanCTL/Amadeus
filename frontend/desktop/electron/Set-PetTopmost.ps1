param(
    [Parameter(Mandatory=$true)][UInt64]$Handle,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetWindowNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
}
'@
$hwnd = [IntPtr]::new([Int64]$Handle)
if ($Apply) {
    $topmost = [IntPtr]::new(-1)
    $flags = [uint32]0x0013  # NOMOVE | NOSIZE | NOACTIVATE
    if (-not [PetWindowNative]::SetWindowPos($hwnd, $topmost, 0, 0, 0, 0, $flags)) {
        throw "SetWindowPos failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
}
$style = [PetWindowNative]::GetWindowLongPtr($hwnd, -20).ToInt64()
"topmost=$([bool]($style -band 0x8)) style=$style"
