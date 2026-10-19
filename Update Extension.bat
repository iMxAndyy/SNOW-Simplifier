@echo off
title ServiceNow Support Hub - Auto Updater
color 0B
echo ========================================================
echo   Updating ServiceNow Support Hub from GitHub...
echo ========================================================
echo.

curl -f -s -L -H "Accept: application/vnd.github.v3.raw" "https://api.github.com/repos/iMxAndyy/SNOW-Simplifier/contents/content.js?ref=main" -o "%~dp0content.js"
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Could not download content.js. Check your internet connection or verify the files are uploaded to the 'main' branch on GitHub.
    pause
    exit /b
)

curl -f -s -L -H "Accept: application/vnd.github.v3.raw" "https://api.github.com/repos/iMxAndyy/SNOW-Simplifier/contents/styles.css?ref=main" -o "%~dp0styles.css"
curl -f -s -L -H "Accept: application/vnd.github.v3.raw" "https://api.github.com/repos/iMxAndyy/SNOW-Simplifier/contents/manifest.json?ref=main" -o "%~dp0manifest.json"

color 0A
echo [SUCCESS] Extension files have been updated to the latest version!
echo.
echo NEXT STEPS:
echo 1. Go to edge://extensions (or chrome://extensions) and click the 'Reload' icon on ServiceNow Support Hub.
echo 2. Return to your ServiceNow browser tab and press F5 (Refresh).
echo.
pause