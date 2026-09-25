"""Make one small NVIDIA NIM request without printing the API key."""

import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


key_file = Path(__file__).resolve().parents[1] / "secrets" / "nvidia_api_key"
key = os.environ.get("NVIDIA_API_KEY") or key_file.read_text(encoding="utf-8").strip()
body = json.dumps({
    "model": "nvidia/nemotron-3-super-120b-a12b",
    "messages": [{"role": "user", "content": "Reply with OK."}],
    "max_tokens": 128,
    "stream": False,
}).encode()
request = Request(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    data=body,
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
)

try:
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
        print(f"NIM works: HTTP {response.status}")
        print("Reply:", str(result["choices"][0]["message"].get("content", ""))[:200])
except HTTPError as error:
    print(f"NIM did not work: HTTP {error.code} {error.reason}")
    raise SystemExit(1)
except URLError as error:
    print(f"NIM connection failed: {error.reason}")
    raise SystemExit(1)
