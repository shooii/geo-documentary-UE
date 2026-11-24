@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0cesium-geo-documentary"

echo ============================================
echo  地理图说 Studio - 启动
echo ============================================
echo.

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 pnpm，请先安装 Node.js 与 pnpm。
  echo.
  pause
  exit /b 1
)

echo 工作目录: %CD%
echo 启动命令: pnpm studio
echo 工作台:   http://127.0.0.1:4180
echo 预览服务: http://127.0.0.1:4174
echo.
echo 服务运行期间请勿关闭本窗口；按 Ctrl+C 或关闭窗口即可停止。
echo.

call pnpm studio

echo.
echo Studio 已退出。
endlocal
