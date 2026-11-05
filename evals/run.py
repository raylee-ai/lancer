#!/usr/bin/env python3
"""One-command entry point: python3 evals/run.py --adapter mock"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lancer_eval.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
