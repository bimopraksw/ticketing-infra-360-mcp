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
npm run build

echo.
echo ================================================
echo   Done! Please QUIT and REOPEN Claude Desktop.
echo ================================================
echo.
pause
