@echo off
title ServiceNow Support Hub - Auto Updater
color 0B
echo ========================================================
echo   Updating ServiceNow Support Hub from GitHub...
echo ========================================================
echo.

set "REPO=https://api.github.com/repos/iMxAndyy/SNOW-Simplifier/contents"
set "NEWBAT=%~dp0Update Extension.new.bat"

rem --- 1. The latest copy of this updater (swapped in at the very end, so new files are always picked up next time)
if exist "%NEWBAT%" del "%NEWBAT%" >nul 2>&1
curl -f -s -L -H "Accept: application/vnd.github.v3.raw" "%REPO%/Update%%20Extension.bat?ref=main" -o "%NEWBAT%"
if %errorlevel% neq 0 if exist "%NEWBAT%" del "%NEWBAT%" >nul 2>&1

rem --- 2. The extension files
curl -f -s -L -H "Accept: application/vnd.github.v3.raw" "%REPO%/content.js?ref=main" -o "%~dp0content.js"
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Could not download content.js. Check your internet connection or verify the files are uploaded to the 'main' branch on GitHub.
    if exist "%NEWBAT%" del "%NEWBAT%" >nul 2>&1
    pause
    exit /b
)

curl -f -s -L -H "Accept: application/vnd.github.v3.raw" "%REPO%/styles.css?ref=main" -o "%~dp0styles.css"
curl -f -s -L -H "Accept: application/vnd.github.v3.raw" "%REPO%/manifest.json?ref=main" -o "%~dp0manifest.json"
curl -f -s -L -H "Accept: application/vnd.github.v3.raw" "%REPO%/password-access.html?ref=main" -o "%~dp0password-access.html"
curl -f -s -L -H "Accept: application/vnd.github.v3.raw" "%REPO%/password-access.js?ref=main" -o "%~dp0password-access.js"

color 0A
echo [SUCCESS] Extension files have been updated to the latest version!
echo.
echo NEXT STEPS:
echo 1. Go to edge://extensions (or chrome://extensions) and click the 'Reload' icon on ServiceNow Support Hub.
echo 2. Return to your ServiceNow browser tab and press F5 (Refresh).
echo.
pause

rem --- 3. Replace this updater with the latest copy. Everything in the brackets is read before the file
rem        changes, so it's safe to overwrite the running script here.
if exist "%NEWBAT%" (
    copy /y "%NEWBAT%" "%~f0" >nul 2>&1
    del "%NEWBAT%" >nul 2>&1
    exit /b
)
