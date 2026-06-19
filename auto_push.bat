@echo off
chcp 65001 > nul

:menu
cls
echo ====================================================
echo        Git Helper Script (SMMTor Node Server)
echo ====================================================
echo.
echo Select an option:
echo [1] Push updates to GitHub (Add, Commit, Pull, Push)
echo [2] Pull latest updates from GitHub (Pull only)
echo [3] Exit
echo.
set /p choice="Enter your choice (1, 2 or 3, default is 1): "

if "%choice%"=="2" goto pull_only
if "%choice%"=="3" goto exit_script
goto push_flow

:push_flow
echo.
echo ====================================================
echo              Option 1: Push Updates
echo ====================================================
:: Automatically configure Git with correct credentials
git config user.email "rx94711485@gmail.com"
git config user.name "Sajala"

:: Ask the user to type "ok" or a commit message
set /p commit_msg="Type 'ok' or commit message and press Enter: "

:: If the user just presses Enter without typing, set default
if "%commit_msg%"=="" set commit_msg=Auto update

echo.
echo [1/4] Adding files to Git...
git add .

echo.
echo [2/4] Committing with message: "%commit_msg%"
git commit -m "%commit_msg%"

echo.
echo [3/4] Pulling latest changes from online (Syncing)...
git pull origin main --no-rebase

echo.
echo [4/4] Pushing to GitHub (origin main)...
git push origin main
goto end

:pull_only
echo.
echo ====================================================
echo              Option 2: Pull Updates
echo ====================================================
echo Pulling latest updates from GitHub...
git pull origin main
goto end

:end
echo.
echo ====================================================
echo    Done! Press any key to return to menu.
echo ====================================================
pause
goto menu

:exit_script
exit
