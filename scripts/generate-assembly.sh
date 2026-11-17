#!/usr/bin/env bash
# Run on x86-64 Linux / WSL with GCC and Python 3. No network access.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache/assembly
gcc -m64 -S -masm=intel -O0 -fno-asynchronous-unwind-tables -fno-stack-protector public/assembly/compare.c -o public/assembly/gcc-O0.s
gcc -m64 -S -masm=intel -O2 -fno-asynchronous-unwind-tables -fno-stack-protector public/assembly/compare.c -o public/assembly/gcc-O2.s
gcc -m64 -O2 tests/native/assembly-check.c -o .cache/assembly/native-check
.cache/assembly/native-check > .cache/assembly/native-check.txt
python3 scripts/package-assembly.py
