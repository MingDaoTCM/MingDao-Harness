@echo off
rem MingDao-Harness one-click installer for Windows (calls install.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Installation ended with an error. See the messages above.
)
pause
