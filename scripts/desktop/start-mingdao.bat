@echo off
rem MingDao 双击启动（Windows）：启动服务器并打开浏览器
start "" cmd /c "mingdao web 3820"
timeout /t 2 /nobreak >nul
start http://127.0.0.1:3820
