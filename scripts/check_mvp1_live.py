"""Exercise the local MVP API with an isolated sample workspace."""

import http.cookiejar
import json
import ssl
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, HTTPSHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
BASE = "https://127.0.0.1:8443"
ORIGIN = BASE
PASSWORD_FILE = ROOT / "secrets" / "local_user_password"

cookies = http.cookiejar.CookieJar()
client = build_opener(
    HTTPCookieProcessor(cookies), HTTPSHandler(context=ssl._create_unverified_context())
)
csrf = ""


def call(method, path, body=None, *, key=False):
    headers = {"Accept": "application/json", "Origin": ORIGIN}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if csrf:
        headers["X-CSRF-Token"] = csrf
    if key:
        headers["Idempotency-Key"] = str(uuid.uuid4())
    payload = json.dumps(body).encode() if body is not None else None
    request = Request(BASE + path, data=payload, headers=headers, method=method)
    try:
        response = client.open(request, timeout=120)
    except HTTPError as error:
        response = error
    raw = response.read().decode()
    result = json.loads(raw) if raw else {}
    print(f"{method} {path}: {response.status}", flush=True)
    if response.status >= 400:
        print(json.dumps(result.get("error"), ensure_ascii=False), flush=True)
        raise RuntimeError(f"API returned {response.status}")
    return result.get("data")


def main():
    global csrf
    scenario = sys.argv[1] if len(sys.argv) > 1 else "approve"
    if scenario not in ("approve", "reject", "stale"):
        raise SystemExit("Use approve, reject, or stale.")
    fixture_file = ROOT.parent / "mvp1-workspace-fixture" / "sample-project" / "src" / "app.ts"
    fixture_file.write_text("export const greeting = 'Hello';\n", encoding="utf-8")
    password = PASSWORD_FILE.read_text(encoding="utf-8").strip()
    session = call("POST", "/api/v1/auth/login", {"password": password})
    csrf = session["csrfToken"]
    assert any(cookie.name == "__Host-pa_session" for cookie in cookies)
    call("GET", "/api/v1/auth/session")
    projects = call("GET", "/api/v1/projects")["projects"]
    project = next((item for item in projects if item["relativeRoot"] == "sample-project"), None)
    if project is None:
        project = call("POST", "/api/v1/projects", {"name": "MVP live check", "relativeRoot": "sample-project"})
    project_id = project["id"]
    conversation = call("POST", f"/api/v1/projects/{project_id}/conversations", {"title": "MVP live check"}, key=True)
    conversation_id = conversation["id"]
    prompt = (
        "Please update the selected TypeScript file so the exported greeting is 'Hello, workspace!'. "
        "Keep the file valid TypeScript. Propose this as a file change for review."
    )
    run_data = call("POST", f"/api/v1/projects/{project_id}/ai-runs", {
        "conversationId": conversation_id,
        "request": prompt,
        "context": {"relativePaths": ["src/app.ts"]},
    }, key=True)
    run_id = run_data["run"]["runId"]
    manifest = run_data["manifest"]
    print(f"run={run_id} consent={manifest['status']} files={manifest['content']['itemCount']}", flush=True)
    call("POST", f"/api/v1/ai-runs/{run_id}/egress-decision", {
        "manifestHash": manifest["manifestHash"], "decision": "approve"
    }, key=True)
    call("POST", f"/api/v1/ai-runs/{run_id}/start", {}, key=True)
    for _ in range(60):
        time.sleep(2)
        run = call("GET", f"/api/v1/ai-runs/{run_id}")
        print(f"status={run['status']} phase={run['phase']} transmission={run['providerTransmission']}", flush=True)
        if run["status"] not in ("running", "approved", "queued", "starting"):
            break
    if run["status"] != "succeeded":
        raise RuntimeError(f"Run ended with {run['status']}: {run['safeMessage']}")
    proposal = call("GET", f"/api/v1/ai-runs/{run_id}/proposed-change-set")
    print(f"proposal={proposal['status']} operations={len(proposal['operations'])}", flush=True)
    operations = proposal["operations"]
    if len(operations) != 1 or operations[0]["path"] != "src/app.ts" or operations[0]["operation"] not in ("edit", "overwrite"):
        raise RuntimeError("The proposal differs from the expected isolated fixture edit.")
    if "Hello, workspace!" not in json.dumps(operations[0]):
        raise RuntimeError("The proposal does not contain the expected greeting.")
    if scenario == "reject":
        rejected = call("POST", f"/api/v1/ai-runs/{run_id}/proposed-change-set/decision", {
            "proposalHash": proposal["proposalHash"], "decision": "reject"
        }, key=True)
        if rejected["status"] != "rejected" or "Hello, workspace!" in fixture_file.read_text(encoding="utf-8"):
            raise RuntimeError("Rejected proposal changed the fixture.")
        print("MVP live rejection passed", flush=True)
        return
    if scenario == "stale":
        fixture_file.write_text("export const greeting = 'Changed after review';\n", encoding="utf-8")
        try:
            call("POST", f"/api/v1/ai-runs/{run_id}/proposed-change-set/decision", {
                "proposalHash": proposal["proposalHash"], "decision": "approve"
            }, key=True)
        except RuntimeError:
            stale = call("GET", f"/api/v1/ai-runs/{run_id}/proposed-change-set")
            if stale["status"] != "stale" or "Changed after review" not in fixture_file.read_text(encoding="utf-8"):
                raise RuntimeError("Stale proposal was not blocked safely.")
            print("MVP live stale-file conflict passed", flush=True)
            return
        raise RuntimeError("A stale proposal was unexpectedly applied.")
    approved = call("POST", f"/api/v1/ai-runs/{run_id}/proposed-change-set/decision", {
        "proposalHash": proposal["proposalHash"], "decision": "approve"
    }, key=True)
    print(f"apply={approved['status']} result={approved.get('result')}", flush=True)
    if "Hello, workspace!" not in fixture_file.read_text(encoding="utf-8"):
        raise RuntimeError("The isolated fixture file was not updated.")
    print("MVP live flow passed", flush=True)


if __name__ == "__main__":
    main()
