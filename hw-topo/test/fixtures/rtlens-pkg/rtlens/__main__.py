"""TEST FIXTURE ONLY - stand-in for the real RTLens CLI.

hw-topo probes this package for `--version` and then calls
`evidence <root> --json`. The payload is served from a canned JSON document
that follows docs/EVIDENCE_CONTRACT.md section 2 exactly (0-based line0 plus
1-based line1, absolute Windows root, root-relative POSIX file paths).

It exists so the cross-backend path can be regression-tested end-to-end
without depending on the upstream command. It is NEVER a source of truth.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_EVIDENCE = os.path.join(os.path.dirname(os.path.dirname(HERE)), "rtlens-evidence.fixture.json")
# HW_TOPO_FIXTURE_RTLENS_EVIDENCE makes the stand-in serve a DIFFERENT document.
# That is how the cross-check negative controls create a witness that disagrees
# with the primary engine about coordinates.
EVIDENCE_PATH = os.environ.get("HW_TOPO_FIXTURE_RTLENS_EVIDENCE") or _DEFAULT_EVIDENCE


def _load():
    with open(EVIDENCE_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main(argv):
    if "--version" in argv or "-V" in argv:
        sys.stdout.write("rtlens v%s\n" % _load()["tool"]["version"])
        return 0
    if argv and argv[0] == "evidence":
        doc = _load()
        # Mirror the real CLI: the scanned root comes from the argument.
        roots = [a for a in argv[1:] if not a.startswith("-")]
        if roots:
            doc = dict(doc)
            doc["root"] = dict(doc["root"])
            doc["root"]["abs"] = os.path.abspath(roots[0])
        sys.stdout.write(json.dumps(doc, indent=2) + "\n")
        return 0
    sys.stderr.write("fixture rtlens: unsupported argv %r\n" % (argv,))
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))