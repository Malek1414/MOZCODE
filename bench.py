"""heartgold benchmark for mozcode's code_search (TypeScript).

Runs scripts/bench-search.ts under Node over a frozen corpus and prints the
elapsed seconds as the last line. Exits non-zero when the search output differs
from the original code's output (recorded once in golden.txt), so a change that
alters results can never count as faster.
"""
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
MAIN_REPO = pathlib.Path("/Users/malekhassan/Desktop/Projects/mozcode")
CACHE = pathlib.Path.home() / ".cache" / "heartgold-mozcode"
CORPUS = CACHE / "corpus"
GOLDEN = CACHE / "golden.txt"

# heartgold runs this inside git worktrees, which have no node_modules.
nm = HERE / "node_modules"
if not nm.exists():
    os.symlink(MAIN_REPO / "node_modules", nm)

proc = subprocess.run(
    ["node", "--no-warnings", "--import", "tsx", "scripts/bench-search.ts", str(CORPUS)],
    cwd=HERE, capture_output=True, text=True, timeout=300,
)
if proc.returncode != 0:
    sys.stderr.write(proc.stdout + proc.stderr)
    sys.exit(1)
lines = proc.stdout.strip().splitlines()
digest = next(l.split()[1] for l in lines if l.startswith("HASH "))
if not GOLDEN.exists():
    GOLDEN.write_text(digest)
elif GOLDEN.read_text().strip() != digest:
    sys.stderr.write("code_search output differs from the original code\n")
    sys.exit(1)
print(lines[-1])
