@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
call "%SCRIPT_DIR%Demo\\start-web.cmd" %*

endlocal
