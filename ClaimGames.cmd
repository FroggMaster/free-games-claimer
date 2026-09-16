@echo off

set SCRIPT_DIR=%~dp0

echo Pulling updates from Github...
cd /d %SCRIPT_DIR%
git pull

echo Claiming Games...
:: Define Configuration Variables 
:: Show the browser during the claiming process
set SHOW=1
node epic-games
:: Disable showing the browser for further claiming
:: set SHOW=0
node prime-gaming
node gog

echo Complete
pause
exit
