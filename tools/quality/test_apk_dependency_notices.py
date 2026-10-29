import importlib.util
from io import BytesIO
from pathlib import Path
import zipfile

spec = importlib.util.spec_from_file_location('apk_contract', Path(__file__).resolve().parents[1] / 'verify_compact_apk_config.py')
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


def check(missing=None, altered=None):
    root = Path(__file__).resolve().parents[2]
    data = BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        for package in contract.DEPENDENCY_NOTICE_PACKAGES:
            if package == missing: continue
            notice = (root / 'assets' / 'licenses' / f'{package}.txt').read_bytes()
            archive.writestr(f'assets/dependency-licenses/{package}.txt', b'incomplete' if package == altered else notice)
    with zipfile.ZipFile(data) as archive:
        return contract._verify_dependency_notices(archive)


def test_upstream_and_packaged_notices_are_complete():
    assert check() == []


def test_missing_notice_blocks_release():
    assert any('fflate' in error for error in check(missing='fflate'))


def test_altered_notice_blocks_release():
    assert any('base64-js' in error for error in check(altered='base64-js'))
