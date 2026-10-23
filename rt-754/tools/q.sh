#!/bin/sh
# usage: q.sh "key 09;wait 300;shot D:/rt9-lab/rt9combo/x.png"
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\rt9-lab\rt9combo\posq.ps1' seq "$1" -Profile 'D:\rt9combo-userdata' 2>&1 | grep -v '^\s*\(At \|+ \|    + \|Category\|FullyQ\)'
