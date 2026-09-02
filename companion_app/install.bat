@echo off
setlocal enableextensions

rem  Register the OpenVideo Downloader companion host on Windows.
rem
rem    install.bat <EXTENSION_ID>
rem    install.bat --uninstall
rem
rem  Writes the host manifest under %LOCALAPPDATA% and points a per-user
rem  registry key at it. Per-user keys need no administrator rights, which is
rem  why this does not request elevation.
rem
rem  The heavy lifting is in host.py --install: generating JSON from batch
rem  means escaping quotes through cmd.exe's parser, and the manifest must
rem  contain an absolute interpreter path, so doing it in Python removes a
rem  whole class of quoting bug.

set "HOST_SCRIPT=%~dp0host.py"

if not exist "%HOST_SCRIPT%" (
  echo error: host.py was not found next to this script.
  echo   expected: %HOST_SCRIPT%
  goto :fail
)

rem  Prefer the py launcher. The Microsoft Store ships a stub named python.exe
rem  that prints a help message and exits instead of running the script, so
rem  finding "python" on PATH is not proof of a usable interpreter.
set "PYTHON="
where py >nul 2>&1 && (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>&1 && set "PYTHON=py -3"
)

if not defined PYTHON (
  where python >nul 2>&1 && (
    python -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>&1 && set "PYTHON=python"
  )
)

if not defined PYTHON (
  echo error: no Python 3.7+ interpreter was found.
  echo.
  echo   Install it with:  winget install Python.Python.3.12
  echo   or download from: https://www.python.org/downloads/windows/
  echo.
  echo   During setup, tick "Add python.exe to PATH".
  goto :fail
)

echo Using interpreter: %PYTHON%

if /i "%~1"=="--uninstall" goto :uninstall
if /i "%~1"=="-u" goto :uninstall

if "%~1"=="" (
  echo error: no extension ID given.
  echo.
  echo   install.bat ^<EXTENSION_ID^>
  echo.
  echo To find the ID:
  echo   1. open chrome://extensions
  echo   2. enable "Developer mode" ^(top right^)
  echo   3. copy the 32-letter ID shown under "OpenVideo Downloader"
  echo.
  echo Reloading the extension from a new folder changes the ID, so re-run
  echo this script if downloads start reporting the host as missing.
  goto :fail
)

%PYTHON% "%HOST_SCRIPT%" --install %*
if errorlevel 1 goto :fail
goto :done

:uninstall
%PYTHON% "%HOST_SCRIPT%" --uninstall
if errorlevel 1 goto :fail
goto :done

:done
echo.
echo Done. Fully quit and reopen Chrome - native messaging hosts are only
echo re-read at browser startup.
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
