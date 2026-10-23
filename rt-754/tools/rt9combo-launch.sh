#!/bin/sh
# rt9 combined verification 2026-10-23 (RT-754 / RT-446): packaged POS main e33fca25, fresh profile D:\rt9combo-userdata, rt9 lab :13000, Descope operators.
# Usage: rt9combo-launch.sh [extra electron args, e.g. --force-high-contrast or --force-device-scale-factor=1.25]
export VITE_API_BASE_URL=http://127.0.0.1:13000
export POS_PULSE_FEATURE_CART=1 POS_PULSE_FEATURE_PAYMENTS=1 POS_PULSE_FEATURE_SALE_FINALIZATION=1 POS_PULSE_FEATURE_PRODUCT_SEARCH=1 POS_PULSE_FEATURE_SHIFT_CASHUP=1 POS_PULSE_FEATURE_RETURNS=1 POS_PULSE_FEATURE_CARD_TENDER=1
export OPERATOR_IDENTITY_PROVIDER=descope
export DESCOPE_PROJECT_ID=P3KyErdApJFbv0HMlZF6Vyagz2vo
unset CLERK_PUBLISHABLE_KEY ELECTRON_RUN_AS_NODE
exec 'C:\Users\Shaaban\Documents\GitHub\POS\.claude\worktrees\rt9lab-e33fca25\dist-electron\win-unpacked\POS Pulse.exe' --user-data-dir='D:\rt9combo-userdata' "$@"
