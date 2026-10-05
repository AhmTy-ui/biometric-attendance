@echo off
rem ──────────────────────────────────────────────────────────────────────────────
rem  BAMP device agent supervisor loop for Windows terminals (no NSSM required).
rem  Restarts the agent whenever it exits:
rem    exit 75  = restart requested (remote restart command, firmware update/rollback) → immediately
rem    exit 0   = operator pressed Q on the kiosk console → stop (unless /always is given)
rem    anything else (crash, lost sensor, …)             → after 5 seconds
rem  Usage: run-forever.cmd [/always]
rem ──────────────────────────────────────────────────────────────────────────────
setlocal EnableExtensions
set "AGENT_DIR=%~dp0.."
pushd "%AGENT_DIR%"

set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo [bamp-device] Node.js 22 not found. Install it from https://nodejs.org/ and retry.
  popd
  exit /b 1
)

set "ALWAYS=0"
if /i "%~1"=="/always" set "ALWAYS=1"

:loop
echo [bamp-device] %DATE% %TIME% starting agent
"%NODE_EXE%" "%AGENT_DIR%\dist\cli.js" run
set "CODE=%ERRORLEVEL%"
echo [bamp-device] %DATE% %TIME% agent exited with code %CODE%
if "%CODE%"=="75" goto loop
if "%CODE%"=="0" if "%ALWAYS%"=="0" goto end
rem 78 = configuration error: wait longer so a broken .env does not spin.
rem (ping is used as a sleep because `timeout` fails when there is no console, e.g. under a SYSTEM task)
if "%CODE%"=="78" (ping -n 61 127.0.0.1 >nul) else (ping -n 6 127.0.0.1 >nul)
goto loop

:end
popd
endlocal
exit /b 0
