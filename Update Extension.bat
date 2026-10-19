@echo off
title ServiceNow Support Hub - Auto Updater
color 0B
echo ========================================================
echo   Updating ServiceNow Support Hub from GitHub...
echo ========================================================
echo.

curl -f -s -L "https://raw.githubusercontent.com/iMxAndyy/SNOW-Simplifier/main/content.js" -o "%~dp0content.js"
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Could not download content.js. Check your internet connection or verify the files are uploaded to the 'main' branch on GitHub.
    pause
    exit /b
)

curl -f -s -L "https://raw.githubusercontent.com/iMxAndyy/SNOW-Simplifier/main/styles.css" -o "%~dp0styles.css"
curl -f -s -L "https://raw.githubusercontent.com/iMxAndyy/SNOW-Simplifier/main/manifest.json" -o "%~dp0manifest.json"

color 0A
echo [SUCCESS] Extension files have been updated to the latest version!
echo.
echo NEXT STEPS:
echo 1. Return to your ServiceNow browser tab and press F5 (Refresh).
echo    (Note: If the banner still shows, click 'Reload' on the extension card at edge://extensions or chrome://extensions first).
echo.
pause