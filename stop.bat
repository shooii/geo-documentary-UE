@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================
echo  地理图说 Studio - 停止
echo ============================================
echo.

rem 项目专用端口：Studio=4180  UE Player=4174  Cesium=4173  Signalling=8888/8889
set "PORTS=4180 4174 4173 8888 8889"
set "STOPPED=0"

for %%P in (%PORTS%) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P " ^| findstr /i "LISTENING"') do (
    taskkill /PID %%a /T /F >nul 2>&1
    if not errorlevel 1 (
      echo 已停止端口 %%P 的进程 PID=%%a
      set "STOPPED=1"
    )
  )
)

echo.
if "!STOPPED!"=="1" (
  echo 相关服务进程已停止。
) else (
  echo 未发现运行中的项目服务进程（可能已停止）。
)
echo.
pause
endlocal
