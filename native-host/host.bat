@echo off
REM Windows can't execute a .js file's shebang line directly, so Chrome needs
REM this thin wrapper as the native messaging host's "path" instead of host.js.
node "%~dp0host.js"
