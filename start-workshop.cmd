@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 22.6 or newer, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH.
  echo Install Node.js 22.6 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Building translation-workshop...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

if not exist "dist\renderer\index.html" (
  echo Renderer build is still missing after build.
  echo Try running: npm run build
  pause
  exit /b 1
)

echo.
echo ========================================
echo   YN Translation Workshop 2.0
echo   Path: %~dp0
echo ========================================
echo.

echo Starting translation-workshop...
call npm start
