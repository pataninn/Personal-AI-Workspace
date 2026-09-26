"""Opt-in authenticated live check for Task 5.2 project task persistence.

Uses the direct application folder, external private credentials, and no provider
calls. Created probe tasks are archived when the check succeeds.
"""

import argparse
import sys
import uuid

from check_mvp2_live import (
    ApiStatusFailure,
    LocalApi,
    ProbeFailure,
    load_local_credentials,
    require,
    select_project,
)


def run_probe():
    password, certificate_path = load_local_credentials()
    api = LocalApi(certificate_path)
    session = api.call("POST", "/api/v1/auth/login", {"password": password})
    require(isinstance(session, dict) and isinstance(session.get("csrfToken"), str), "login_failed")
    api.csrf_token = session["csrfToken"]
    project_id = select_project(api)
    path = "/api/v1/projects/{}/tasks".format(project_id)
    initial = api.call("GET", path)
    require(isinstance(initial, dict) and isinstance(initial.get("tasks"), list), "invalid_task_list")
    for stale in initial["tasks"]:
        if isinstance(stale, dict) and str(stale.get("title", "")).startswith("MVP2 task probe "):
            api.call("PATCH", path + "/" + stale["id"], {"status": "archived"},
                     headers={"If-Match": '"{}"'.format(stale["version"])})
    initial = api.call("GET", path)
    initial_count = len(initial["tasks"])

    suffix = uuid.uuid4().hex[:10]
    first = api.call("POST", path, {"title": "MVP2 task probe A " + suffix},
                     headers={"Idempotency-Key": "mvp2-task-a-" + suffix}, expected_status=201)
    first_task = first["task"]
    require(first_task["status"] == "todo" and first_task["version"] == 1, "create_a_mismatch")
    replay = api.call("POST", path, {"title": "MVP2 task probe A " + suffix},
                      headers={"Idempotency-Key": "mvp2-task-a-" + suffix}, expected_status=201)
    require(replay["task"]["id"] == first_task["id"], "idempotency_failed")
    api.call("POST", path, {"title": "Different task " + suffix},
             headers={"Idempotency-Key": "mvp2-task-a-" + suffix}, expected_status=409)
    api.call("GET", "/api/v1/projects/{}/tasks".format(uuid.uuid4()), expected_status=404)

    second = api.call("POST", path, {"title": "MVP2 task probe B " + suffix},
                      headers={"Idempotency-Key": "mvp2-task-b-" + suffix}, expected_status=201)
    second_task = second["task"]
    listed = api.call("GET", path)
    require(len(listed["tasks"]) == initial_count + 2, "create_not_persisted")
    require([task["id"] for task in listed["tasks"][-2:]] == [first_task["id"], second_task["id"]], "append_order_mismatch")

    edited = api.call("PATCH", path + "/" + first_task["id"],
                      {"title": "MVP2 task probe A edited " + suffix},
                      headers={"If-Match": '"1"'})["task"]
    require(edited["version"] == 2, "edit_version_mismatch")
    api.call("PATCH", path + "/" + first_task["id"], {"title": "stale"},
             headers={"If-Match": '"1"'}, expected_status=409)

    moved = api.call("PATCH", "/api/v1/projects/{}/task-order".format(project_id),
                     {"taskId": second_task["id"], "direction": "up"},
                     headers={"If-Match": '"{}"'.format(listed["orderVersion"])})
    require([task["id"] for task in moved["tasks"]][-2:] == [second_task["id"], first_task["id"]], "reorder_mismatch")
    api.call("PATCH", "/api/v1/projects/{}/task-order".format(project_id),
             {"taskId": second_task["id"], "direction": "up"},
             headers={"If-Match": '"{}"'.format(listed["orderVersion"])}, expected_status=409)

    done = api.call("PATCH", path + "/" + first_task["id"], {"status": "done"},
                    headers={"If-Match": '"2"'})["task"]
    require(done["status"] == "done" and done["completedAt"], "completion_mismatch")
    archived_first = api.call("PATCH", path + "/" + first_task["id"], {"status": "archived"},
                              headers={"If-Match": '"{}"'.format(done["version"])})["task"]
    archived_second = api.call("PATCH", path + "/" + second_task["id"], {"status": "archived"},
                               headers={"If-Match": '"1"'})["task"]
    require(archived_first["status"] == "archived" and archived_second["status"] == "archived", "archive_mismatch")
    final = api.call("GET", path)
    require(len(final["tasks"]) == initial_count, "archive_not_persisted")
    require(all(task["position"] == index for index, task in enumerate(final["tasks"])), "dense_order_mismatch")
    print("Task 5.2 live task API check passed", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Check Task 5.2 against the local MVP2 API.")
    parser.add_argument("--confirm-live-local-api", action="store_true")
    args = parser.parse_args()
    if not args.confirm_live_local_api:
        parser.error("pass --confirm-live-local-api to enable local API requests")
    try:
        run_probe()
    except ApiStatusFailure as error:
        print("Task 5.2 live check failed status={}".format(error.status), file=sys.stderr)
        return 1
    except ProbeFailure as error:
        print("Task 5.2 live check failed check={}".format(error), file=sys.stderr)
        return 1
    except Exception as error:
        print("Task 5.2 live check failed error={}".format(type(error).__name__), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
