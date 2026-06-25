@echo off
setlocal

cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd was not found. Install Node.js LTS, then run this again.
  echo.
  pause
  exit /b 1
)

if /i not "%FANSLY_OVERLAY_SKIP_UPDATE_CHECK%"=="1" (
  if exist "scripts\check-update.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\check-update.ps1"
    echo.
  )
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Dependency install failed.
    pause
    exit /b 1
  )
)

echo Installing/Checking Playwright Chromium...
call npx.cmd playwright install chromium
if errorlevel 1 (
  echo.
  echo Playwright Chromium install failed.
  pause
  exit /b 1
)

echo Starting Fansly Leaderboard Overlay...
echo Dashboard: http://127.0.0.1:8787/
echo OBS URL:   http://127.0.0.1:8787/overlay
echo.
call npm.cmd start

set "exitCode=%errorlevel%"
echo.
echo Fansly Leaderboard Overlay stopped with exit code %exitCode%.
pause
exit /b %exitCode%
