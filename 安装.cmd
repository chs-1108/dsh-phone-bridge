@echo off
REM phone-bridge one-click installer launcher.
REM Double-click this file. It asks for elevation if needed, then opens the
REM installer window.

setlocal
cd /d "%~dp0"

set "SCRIPT=%~dp0install-gui.ps1"
if not exist "%SCRIPT%" (
    echo.
    echo   install-gui.ps1 is missing next to this file.
    echo   Download the whole repository, not just this .cmd.
    echo.
    pause
    exit /b 1
)

REM Elevate: installing Tailscale and patching the DSH profile need admin.
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo.
    echo   Asking for administrator rights...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
if errorlevel 1 (
    echo.
    echo   The installer stopped. The window shows the full log.
    pause
)
endlocal
