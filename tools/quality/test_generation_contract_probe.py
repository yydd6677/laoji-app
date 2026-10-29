import importlib.util
import json
from pathlib import Path
import re
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location('generation_contract_probe', Path(__file__).with_name('probe_generation_contract.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@pytest.mark.parametrize('fault', [None, 'user_wins', 'extra_field', 'wrong_type', 'invalid_json'])
def test_probe_rejects_semantic_and_protocol_failures(fault):
    calls = []
    def call(config, system, user, **kwargs):
        calls.append(kwargs)
        schema = json.dumps(kwargs['response_format'])
        expected = re.search(r'SYS_[0-9a-f]+', system).group()
        assert expected not in schema  # The grammar cannot force a semantic pass.
        value = {'label': expected, 'proof': {'count': 7, 'active': True}}
        if fault == 'user_wins':
            value = {'label': re.search(r'USER_[0-9a-f]+', user).group(), 'proof': {'count': 99, 'active': False}}
        if fault == 'extra_field': value['extra'] = True
        if fault == 'wrong_type': value['proof']['count'] = '7'
        return 'invalid' if fault == 'invalid_json' else json.dumps(value)
    provider = SimpleNamespace(call_llm=call, LlmConfig=lambda **kwargs: kwargs,
        canonical_ollama_base_url=lambda: 'http://localhost:21434',
        GENERATION_MODEL='test', configured_provider=lambda: 'ollama')
    result = probe.probe(provider)
    assert result['passed'] is (fault is None)
    assert [row['priority'] for row in result['cases']] == ['interactive', 'background']
    assert len(calls) == 2
