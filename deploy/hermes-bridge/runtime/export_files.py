"""Bounded regular-file export from the isolated project copy only."""
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
if not str(root).startswith('/sandbox/pai-runs/pai-') or root.name != 'project':
    raise RuntimeError('Invalid export root')
result = []
total = 0
for directory, dirs, files in os.walk(root, followlinks=False):
    dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('node_modules', 'dist', 'coverage', '__pycache__')]
    for dirname in dirs:
        if (Path(directory) / dirname).is_symlink():
            raise RuntimeError('Symbolic link directories are not exportable')
    for name in files:
        if name.startswith('.') or name.endswith('.pyc'):
            continue
        path = Path(directory) / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('Only regular files are exportable')
        if path.stat().st_size > 256 * 1024:
            raise RuntimeError('Generated file exceeds the per-file limit')
        content = path.read_bytes()
        content.decode('utf-8', errors='strict')
        total += len(content)
        if total > 512 * 1024 or len(result) >= 100:
            raise RuntimeError('Generated project exceeds the export limit')
        result.append({'path': str(path.relative_to(root)), 'content': base64.b64encode(content).decode(), 'sha256': hashlib.sha256(content).hexdigest()})
print(json.dumps(result, separators=(',', ':')))
