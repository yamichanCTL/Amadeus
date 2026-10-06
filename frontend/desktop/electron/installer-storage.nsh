; Upgrade/silent uninstall always keeps data. Interactive uninstall asks through
; the app's marker-checked cleanup implementation, before removing its executable.
; Never feed a user-selected directory to NSIS RMDir.
!macro customUnInit
  ${IfNot} ${Silent}
    ${IfNot} ${isUpdated}
      Call un.checkAppRunning
      IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 amadeus_storage_done
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --amadeus-uninstall-data' $R0
      ${If} $R0 != 0
        MessageBox MB_OK|MB_ICONINFORMATION "Amadeus 数据清理未完成，部分文件可能已删除。程序将继续卸载；请按刚才提示的路径检查剩余数据。"
      ${EndIf}
      amadeus_storage_done:
    ${EndIf}
  ${EndIf}
!macroend
