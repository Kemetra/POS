#!/bin/sh
# usage: q.sh "key 09;wait 300;shot D:/rt9-lab/rt9rerun/x.png"   (profile D:\rt9rerun-userdata)
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\rt9-lab\rt9rerun\posq.ps1' seq "$1" -Profile 'D:\rt9rerun-userdata' 2>&1 | grep -v '^\s*\(At \|+ \|    + \|Category\|FullyQ\)'