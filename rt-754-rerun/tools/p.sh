#!/bin/sh
# usage: p.sh <pos.ps1 args...>   (profile D:\rt9rerun-userdata)
powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\rt9-lab\rt9rerun\pos.ps1' "$@" -Profile 'D:\rt9rerun-userdata' 2>&1 | grep -v '^\s*\(At \|+ \|    + \|Category\|FullyQ\)'