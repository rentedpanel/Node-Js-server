@echo off
setlocal EnableExtensions
chcp 65001 > nul
cd /d "%~dp0"

set "SCRIPT_VER=2.1"

:menu
cls
echo ====================================================
echo        Git Helper Script (SMMTor Node Server)
echo        Version %SCRIPT_VER%
echo ====================================================
echo.
echo   1. Push my updates to GitHub
echo   2. Sync from GitHub (replace local with online)
echo   3. Exit
echo.
set "choice="
set /p choice="Enter choice (1-3, default 1): "

if "%choice%"=="2" goto pull_only
if "%choice%"=="3" goto exit_script
if "%choice%"=="" goto push_flow
if "%choice%"=="1" goto push_flow
echo Invalid choice.
pause > nul
goto menu

:push_flow
echo.
echo ====================================================
echo   Option 1: Push Updates
echo ====================================================
git config user.email "rx94711485@gmail.com"
git config user.name "Sajala"

set "commit_msg="
set /p commit_msg="Commit message (Enter = Auto update): "
if "%commit_msg%"=="" set "commit_msg=Auto update"

echo.
echo Step 1 of 4 - Adding files...
git add .
if errorlevel 1 goto git_error

echo Step 2 of 4 - Committing...
git commit -m "%commit_msg%"

echo Step 3 of 4 - Pulling from GitHub...
git pull origin main --no-rebase
if errorlevel 1 goto git_error

echo Step 4 of 4 - Pushing to GitHub...
git push origin main
if errorlevel 1 goto git_error

echo.
echo Push completed successfully.
goto end

:pull_only
echo.
echo ====================================================
echo   Option 2: Sync from GitHub
echo   Script version %SCRIPT_VER%
echo ====================================================
echo.
echo Local files will match GitHub exactly.
echo WARNING: Uncommitted local changes will be lost.
echo.
set "confirm="
set /p confirm="Type Y to continue: "
if /i not "%confirm%"=="Y" (
    echo Cancelled.
    goto end
)

echo.
echo Step 1 of 3 - Fetching from GitHub...
git fetch origin
if errorlevel 1 goto git_error

echo.
echo Step 2 of 3 - Replacing local files...
git reset --hard origin/main
if errorlevel 1 goto git_error

echo.
echo Step 3 of 3 - Status check...
git status

echo.
echo Sync completed successfully.
goto end

:git_error
echo.
echo ERROR: Git command failed. Check internet, branch, and git login.
goto end

:end
echo.
pause > nul
goto menu

:exit_script
endlocal
exit /b 0
