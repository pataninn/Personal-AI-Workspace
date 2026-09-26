"""Opt-in live NIM task suggestion check with no file context or file changes."""

import argparse
import sys
import time
import uuid

from check_mvp2_live import (
    ApiStatusFailure,
    LocalApi,
    ProbeFailure,
    load_local_credentials,
    require,
    select_project,
)


def run_probe(resume_run_id=None):
    password, certificate_path = load_local_credentials()
    api = LocalApi(certificate_path)
    session = api.call("POST", "/api/v1/auth/login", {"password": password})
    require(isinstance(session, dict) and isinstance(session.get("csrfToken"), str), "login_failed")
    api.csrf_token = session["csrfToken"]
    project_id = select_project(api)
    marker = uuid.uuid4().hex[:8]
    if resume_run_id:
        run_id = resume_run_id
        conversation_id = None
    else:
        conversation = api.call("POST", "/api/v1/projects/{}/conversations".format(project_id),
                            {"title": "MVP2 suggestion check " + marker},
                            headers={"Idempotency-Key": "mvp2-suggestion-conversation-" + marker}, expected_status=201)
        conversation_id = conversation["id"]
        prompt = ("Suggest exactly one small project task titled 'Review local setup notes " + marker +
              "' with details 'Review the existing setup documentation.' "
              "Return it in the structured taskSuggestions field. Do not propose file changes or commands.")
        created = api.call("POST", "/api/v1/projects/{}/ai-runs".format(project_id),
                       {"conversationId": conversation_id, "request": prompt,
                        "context": {"relativePaths": []}},
                       headers={"Idempotency-Key": "mvp2-suggestion-run-" + marker}, expected_status=202)
        run_id = created["run"]["runId"]
        manifest = created["manifest"]
        require(manifest["content"]["itemCount"] == 0, "unexpected_provider_context")
        api.call("POST", "/api/v1/ai-runs/{}/egress-decision".format(run_id),
             {"manifestHash": manifest["manifestHash"], "decision": "approve"},
             headers={"Idempotency-Key": "mvp2-suggestion-consent-" + marker})
        api.call("POST", "/api/v1/ai-runs/{}/start".format(run_id), {},
             headers={"Idempotency-Key": "mvp2-suggestion-start-" + marker}, expected_status=202)
    run = None
    for _ in range(45):
        time.sleep(2)
        run = api.call("GET", "/api/v1/ai-runs/{}".format(run_id))
        if run["status"] not in ("running", "approved", "queued", "starting"):
            break
    if run is None or run["status"] != "succeeded":
        print("run_status={} failure_code={} safe_message={}".format(run["status"] if run else "unavailable", run.get("failureCode") if run else None, run.get("safeMessage") if run else None), flush=True)
        raise ProbeFailure("run_not_succeeded")
    conversation_id = run["conversationId"]
    suggestions = run.get("taskSuggestions")
    require(isinstance(suggestions, list) and len(suggestions) == 1, "run_suggestion_count_mismatch")
    suggestion = suggestions[0]
    require(suggestion["status"] == "pending" and suggestion["title"].startswith("Review local setup notes "),
            "suggestion_payload_mismatch")
    task_list = api.call("GET", "/api/v1/projects/{}/tasks".format(project_id))
    require(not any(task["title"] == suggestion["title"] for task in task_list["tasks"]), "suggestion_auto_created_task")
    pending = api.call("GET", "/api/v1/projects/{}/task-suggestions".format(project_id))
    require(any(item["id"] == suggestion["id"] for item in pending["taskSuggestions"]), "suggestion_not_persisted")
    accepted = api.call("PATCH", "/api/v1/projects/{}/task-suggestions/{}".format(project_id, suggestion["id"]),
                        {"status": "accepted"}, headers={"If-Match": '"1"'})
    task = accepted["task"]
    require(task["source"]["kind"] == "assistant_suggestion" and task["source"]["suggestionId"] == suggestion["id"],
            "accepted_task_source_mismatch")
    repeat = api.call("PATCH", "/api/v1/projects/{}/task-suggestions/{}".format(project_id, suggestion["id"]),
                      {"status": "accepted"}, headers={"If-Match": '"1"'})
    require(repeat["task"]["id"] == task["id"], "duplicate_accept_created_task")
    conversation_suggestions = api.call("GET", "/api/v1/projects/{}/task-suggestions?status=all&conversationId={}".format(project_id, conversation_id))
    require(any(item["id"] == suggestion["id"] and item["status"] == "accepted" for item in conversation_suggestions["taskSuggestions"]),
            "accepted_suggestion_not_reloaded")
    api.call("PATCH", "/api/v1/projects/{}/tasks/{}".format(project_id, task["id"]),
             {"status": "archived"}, headers={"If-Match": '"{}"'.format(task["version"])})
    print("Task 5.2 live NIM suggestion check passed run={} proposal_count=1".format(run_id), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Check direct NIM task suggestion persistence and acceptance.")
    parser.add_argument("--confirm-live-provider", action="store_true")
    parser.add_argument("--resume-run-id")
    args = parser.parse_args()
    if not args.confirm_live_provider:
        parser.error("pass --confirm-live-provider to enable the local provider run")
    try:
        run_probe(args.resume_run_id)
    except ApiStatusFailure as error:
        print("Task 5.2 suggestion check failed status={}".format(error.status), file=sys.stderr)
        return 1
    except ProbeFailure as error:
        print("Task 5.2 suggestion check failed check={}".format(error), file=sys.stderr)
        return 1
    except Exception as error:
        print("Task 5.2 suggestion check failed error={}".format(type(error).__name__), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
