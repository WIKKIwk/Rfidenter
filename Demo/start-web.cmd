@echo off
setlocal

if not defined PORT set "PORT=8787"
if not "%1"=="" set "PORT=%1"

if not defined HOST set "HOST=127.0.0.1"
if not "%2"=="" set "HOST=%2"

set "SCRIPT_DIR=%~dp0"

node "%SCRIPT_DIR%web-localhost\\server\\server.js" --host %HOST% --port %PORT%

endlocal
