#!/bin/sh
# usage: p.sh <pos.ps1 args...>   (profile D:\rt9combo-userdata)
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\rt9-lab\bench\pos.ps1' "$@" -Profile 'D:\rt9combo-userdata' 2>&1 | grep -v '^\s*\(At \|+ \|    + \|Category\|FullyQ\)'
