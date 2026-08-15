@echo off
setlocal

cd /d "%~dp0..\.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  pause
  exit /b 1
)

echo Setting up toy-agent-artifacts...
call npm run setup:toy-agent-artifacts
if errorlevel 1 exit /b 1

echo.
echo Running headless verification...
call npm run verify:toy-agent-artifacts
if errorlevel 1 (
  echo Verification failed — fix before opening the app.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

echo.
echo Starting translation-workshop dev mode...
echo In the app: Open project folder -^> examples\toy-agent-artifacts
echo.
call npm run dev
