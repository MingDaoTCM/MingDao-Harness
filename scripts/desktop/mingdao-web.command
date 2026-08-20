#!/bin/bash
# MingDao 双击启动（macOS）：启动服务器并打开默认浏览器
nohup mingdao web 3820 >/dev/null 2>&1 &
sleep 1
open http://127.0.0.1:3820
