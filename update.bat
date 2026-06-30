@echo off

echo.
echo ================================================
echo   Updating ticketing-infra-360-mcp...
echo ================================================
echo.

cd /d "%~dp0"

echo [1/2] Downloading latest update...
git pull

echo.
echo [2/2] Building...
call npm run build

echo.
echo ================================================
echo   Done! You're on the latest version.
echo.
echo   No need to do anything else. From now on this
echo   updates itself automatically in the background,
echo   so you normally won't need to run this again.
echo ================================================
echo.
pause
