#!/bin/sh
# rt9 re-verification 2026-10-23 (RT-446 S1/S7b/S9, RT-754 AC4): packaged POS main 5dc16c5a, fresh profile D:\rt9rerun-userdata, rt9 lab :13000, Descope operators.
# Same feature flags as rt9combo-launch.sh (POS_PULSE_FEATURE_SALE_TENDERS_SINCE still unset: tenders are not sent).
# Usage: rt9rerun-launch.sh [extra electron args, e.g. --force-device-scale-factor=1.25]
export VITE_API_BASE_URL=http://127.0.0.1:13000
export POS_PULSE_FEATURE_CART=1 POS_PULSE_FEATURE_PAYMENTS=1 POS_PULSE_FEATURE_SALE_FINALIZATION=1 POS_PULSE_FEATURE_PRODUCT_SEARCH=1 POS_PULSE_FEATURE_SHIFT_CASHUP=1 POS_PULSE_FEATURE_RETURNS=1 POS_PULSE_FEATURE_CARD_TENDER=1
export OPERATOR_IDENTITY_PROVIDER=descope
export DESCOPE_PROJECT_ID=P3KyErdApJFbv0HMlZF6Vyagz2vo
unset CLERK_PUBLISHABLE_KEY ELECTRON_RUN_AS_NODE
exec 'C:\Users\Shaaban\Documents\GitHub\POS\.claude\worktrees\rt9rerun-5dc16c5a\dist-electron\win-unpacked\POS Pulse.exe' --user-data-dir='D:\rt9rerun-userdata' "$@"