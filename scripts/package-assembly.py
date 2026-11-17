"""Package native compiler output without fetching or synthesizing assembly."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
source = (root / 'public/assembly/compare.c').read_text(encoding='utf-8')
data = {
    'checkedAt': datetime.date.today().isoformat(),
    'compiler': subprocess.check_output(['gcc', '--version'], text=True).splitlines()[0],
    'target': subprocess.check_output(['gcc', '-dumpmachine'], text=True).strip(),
    'abi': 'Microsoft x64 ABI explicitly selected with __attribute__((ms_abi)); Linux GCC output, not a Windows PE artifact.',
    'flags': '-m64 -S -masm=intel -O0/-O2 -fno-asynchronous-unwind-tables -fno-stack-protector',
    'sourceHash': hashlib.sha256(source.encode()).hexdigest(),
    'source': source,
    'nativeChecks': (root / '.cache/assembly/native-check.txt').read_text().strip(),
    'outputs': {level: (root / f'public/assembly/gcc-{level}.s').read_text() for level in ['O0', 'O2']},
}
(root / 'src/content/assembly-fixture.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
metadata = {key: value for key, value in data.items() if key not in ['source', 'outputs']}
metadata['outputHashes'] = {level: hashlib.sha256(text.encode()).hexdigest() for level, text in data['outputs'].items()}
(root / 'public/assembly/provenance.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'compiler': data['compiler'], 'nativeChecks': data['nativeChecks']}))
