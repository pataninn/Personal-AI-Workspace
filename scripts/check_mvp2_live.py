"""Opt-in local API check for the direct-workspace MVP2 setup.

This script makes no provider calls and does not change workspace files. It creates
one uniquely named temporary project fact, exercises its lifecycle, and removes it.
"""

import argparse
import http.cookiejar
import json
import os
import ssl
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, HTTPSHandler, Request, build_opener
from urllib.parse import urlencode


ROOT = Path(__file__).resolve().parents[1]
BASE_URL = "https://127.0.0.1:8443"
ORIGIN = BASE_URL
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_WORKSPACE_READ_BYTES = 256 * 1024
MAX_WORKSPACE_OUTPUT_BYTES = 128 * 1024
FACT_CONTENT = "Temporary harmless fact created by the opt-in MVP2 API check."
EDITED_FACT_CONTENT = "Temporary harmless fact edited by the opt-in MVP2 API check."


class ProbeFailure(Exception):
    """A safe-to-report probe failure without request or response contents."""


class ApiStatusFailure(ProbeFailure):
    def __init__(self, status):
        super().__init__("unexpected_status")
        self.status = status


def is_within(candidate, root):
    try:
        common = os.path.commonpath([str(candidate), str(root)])
    except ValueError:
        return False
    return os.path.normcase(common) == os.path.normcase(str(root))


def private_paths():
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise ProbeFailure("local_app_data_unavailable")
    private_root = (Path(local_app_data) / "Personal-AI-Workspace" / "private").resolve()
    repository_root = ROOT.resolve()
    if is_within(private_root, repository_root):
        raise ProbeFailure("private_directory_inside_repository")
    return (
        private_root / "secrets" / "local_user_password",
        private_root / "tls" / "tls.crt",
    )


class LocalApi:
    def __init__(self, ca_file):
        cookies = http.cookiejar.CookieJar()
        tls_context = ssl.create_default_context(cafile=str(ca_file))
        self.client = build_opener(HTTPCookieProcessor(cookies), HTTPSHandler(context=tls_context))
        self.cookies = cookies
        self.csrf_token = ""

    def call(self, method, path, body=None, headers=None, expected_status=200, parse_json=True):
        request_headers = {"Accept": "application/json", "Origin": ORIGIN}
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        if self.csrf_token:
            request_headers["X-CSRF-Token"] = self.csrf_token
        if headers:
            request_headers.update(headers)
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        request = Request(BASE_URL + path, data=payload, headers=request_headers, method=method)
        try:
            response = self.client.open(request, timeout=20)
        except HTTPError as error:
            response = error
        except Exception:
            raise ProbeFailure("local_api_request_failed") from None

        status = response.getcode()
        print("{} {} status={}".format(method, path, status), flush=True)
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        response.close()
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ProbeFailure("response_limit_exceeded")
        if status != expected_status:
            raise ApiStatusFailure(status)
        if not parse_json or status == 204:
            return None
        try:
            envelope = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ProbeFailure("invalid_api_response") from None
        if not isinstance(envelope, dict) or "data" not in envelope:
            raise ProbeFailure("invalid_api_envelope")
        return envelope["data"]


def require(condition, code):
    if not condition:
        raise ProbeFailure(code)


def load_local_credentials():
    password_path, certificate_path = private_paths()
    try:
        password = password_path.read_text(encoding="utf-8").strip()
        certificate_path.stat()
    except OSError:
        raise ProbeFailure("private_login_or_tls_file_unavailable") from None
    require(bool(password), "local_password_empty")
    return password, certificate_path


def list_facts(api, project_id):
    data = api.call("GET", "/api/v1/projects/{}/facts".format(project_id))
    require(isinstance(data, dict) and isinstance(data.get("facts"), list), "invalid_fact_list")
    return data["facts"]


def find_fact(facts, fact_id):
    matches = [fact for fact in facts if isinstance(fact, dict) and fact.get("id") == fact_id]
    require(len(matches) == 1, "fact_not_persisted")
    return matches[0]


def unwrap_fact_response(data, code):
    require(isinstance(data, dict) and isinstance(data.get("fact"), dict), code)
    return data["fact"]


def verify_fact(fact, title, content, status, version):
    require(
        fact.get("title") == title
        and fact.get("content") == content
        and fact.get("verificationStatus") == status
        and fact.get("version") == version,
        "fact_state_mismatch",
    )


def select_project(api):
    data = api.call("GET", "/api/v1/projects?includeArchived=false")
    require(isinstance(data, dict) and isinstance(data.get("projects"), list), "invalid_project_list")
    project = next(
        (item for item in data["projects"] if item.get("relativeRoot") == "." and item.get("status") == "active"),
        None,
    )
    if project is None:
        try:
            project = api.call(
                "POST",
                "/api/v1/projects",
                {"name": "MVP2 live API check", "relativeRoot": "."},
                expected_status=201,
            )
        except ApiStatusFailure as error:
            if error.status != 409:
                raise
            data = api.call("GET", "/api/v1/projects?includeArchived=false")
            project = next(
                (item for item in data.get("projects", []) if item.get("relativeRoot") == "." and item.get("status") == "active"),
                None,
            )
            if project is None:
                raise
    require(isinstance(project, dict) and isinstance(project.get("id"), str), "project_unavailable")
    require(project.get("relativeRoot") == "." and project.get("status") == "active", "project_root_mismatch")
    print("project_id={} relative_root=.".format(project["id"]), flush=True)
    return project["id"]


def check_workspace(api, project_id):
    read_path = "/api/v1/projects/{}/files/content?{}".format(
        project_id, urlencode({"path": "README.md"})
    )
    result = api.call("GET", read_path)
    require(isinstance(result, dict), "invalid_workspace_read")
    content = result.get("content")
    require(
        result.get("path") == "README.md"
        and result.get("encoding") == "utf-8"
        and isinstance(content, str)
        and bool(content),
        "workspace_read_mismatch",
    )
    content_bytes = len(content.encode("utf-8"))
    size_bytes = result.get("sizeBytes")
    require(
        isinstance(size_bytes, int)
        and not isinstance(size_bytes, bool)
        and 0 <= size_bytes <= MAX_WORKSPACE_READ_BYTES
        and content_bytes <= MAX_WORKSPACE_OUTPUT_BYTES,
        "workspace_read_exceeded_bounds",
    )
    print(
        "workspace_read bytes={} returned_bytes={} truncated={}".format(
            size_bytes, content_bytes, bool(result.get("truncated"))
        ),
        flush=True,
    )

    protected_path = "/api/v1/projects/{}/files/content?{}".format(
        project_id, urlencode({"path": ".git/config"})
    )
    api.call("GET", protected_path, expected_status=403, parse_json=False)
    print("protected_git_denied=true", flush=True)


def cleanup_fact(api, project_id, title, fact_id=None):
    try:
        facts = list_facts(api, project_id)
        candidates = [
            fact
            for fact in facts
            if isinstance(fact, dict)
            and fact.get("title") == title
            and fact.get("content") in (FACT_CONTENT, EDITED_FACT_CONTENT)
            and (fact_id is None or fact.get("id") == fact_id)
        ]
        if not candidates:
            print("cleanup status=already_absent", flush=True)
            return True
        if len(candidates) != 1:
            print("cleanup status=skipped_ambiguous", flush=True)
            return False
        fact = candidates[0]
        version = fact.get("version")
        candidate_id = fact.get("id")
        require(
            isinstance(candidate_id, str)
            and isinstance(version, int)
            and not isinstance(version, bool)
            and version > 0,
            "cleanup_fact_metadata_invalid",
        )
        api.call(
            "DELETE",
            "/api/v1/projects/{}/facts/{}".format(project_id, candidate_id),
            headers={"If-Match": '"{}"'.format(version)},
            expected_status=204,
            parse_json=False,
        )
        remaining = list_facts(api, project_id)
        require(not any(item.get("id") == candidate_id for item in remaining if isinstance(item, dict)), "cleanup_not_persisted")
        print("cleanup status=deleted remaining_fact_count={}".format(len(remaining)), flush=True)
        return True
    except Exception:
        print("cleanup status=failed", flush=True)
        return False


def check_facts(api, project_id):
    test_title = "MVP2 live check " + uuid.uuid4().hex
    created_id = None
    cleanup_required = False
    deleted = False
    active_error = None
    try:
        starting_facts = list_facts(api, project_id)
        print("starting_fact_count={}".format(len(starting_facts)), flush=True)
        cleanup_required = True
        created = unwrap_fact_response(api.call(
            "POST",
            "/api/v1/projects/{}/facts".format(project_id),
            {"title": test_title, "content": FACT_CONTENT},
            expected_status=201,
        ), "invalid_created_fact")
        created_id = created.get("id")
        require(isinstance(created_id, str), "created_fact_id_missing")
        require(created.get("version") == 1, "created_fact_version_mismatch")
        print("fact_id={}".format(created_id), flush=True)

        created_facts = list_facts(api, project_id)
        created_fact = find_fact(created_facts, created_id)
        verify_fact(created_fact, test_title, FACT_CONTENT, "needs_review", 1)
        print("created_fact_count={}".format(len(created_facts)), flush=True)

        reviewed = unwrap_fact_response(api.call(
            "POST",
            "/api/v1/projects/{}/facts/{}/verification".format(project_id, created_id),
            {"expectedVersion": 1},
        ), "invalid_verification_response")
        require(reviewed.get("version") == 2, "verification_version_mismatch")
        require(reviewed.get("verificationStatus") == "verified" and bool(reviewed.get("verifiedAt")), "verification_state_mismatch")
        reviewed_facts = list_facts(api, project_id)
        verify_fact(find_fact(reviewed_facts, created_id), test_title, FACT_CONTENT, "verified", 2)
        print("verified_fact_count={}".format(len(reviewed_facts)), flush=True)

        edited = unwrap_fact_response(api.call(
            "PATCH",
            "/api/v1/projects/{}/facts/{}".format(project_id, created_id),
            {
                "title": test_title,
                "content": EDITED_FACT_CONTENT,
                "expectedVersion": 2,
            },
        ), "invalid_edit_response")
        require(edited.get("version") == 3, "edit_version_mismatch")
        require(edited.get("verificationStatus") == "needs_review" and edited.get("verifiedAt") is None, "edit_review_state_mismatch")
        edited_facts = list_facts(api, project_id)
        verify_fact(find_fact(edited_facts, created_id), test_title, EDITED_FACT_CONTENT, "needs_review", 3)
        print("edited_fact_count={}".format(len(edited_facts)), flush=True)

        api.call(
            "DELETE",
            "/api/v1/projects/{}/facts/{}".format(project_id, created_id),
            headers={"If-Match": '"3"'},
            expected_status=204,
            parse_json=False,
        )
        remaining = list_facts(api, project_id)
        require(not any(item.get("id") == created_id for item in remaining if isinstance(item, dict)), "delete_not_persisted")
        deleted = True
        print("deleted_fact_count={}".format(len(remaining)), flush=True)
    except Exception as error:
        active_error = error
        raise
    finally:
        if cleanup_required and not deleted:
            cleaned = cleanup_fact(api, project_id, test_title, created_id)
            if not cleaned and active_error is None:
                raise ProbeFailure("cleanup_failed") from None


def run_probe():
    password, certificate_path = load_local_credentials()
    api = LocalApi(certificate_path)
    session = api.call("POST", "/api/v1/auth/login", {"password": password})
    require(isinstance(session, dict) and isinstance(session.get("csrfToken"), str), "login_failed")
    api.csrf_token = session["csrfToken"]
    require(any(cookie.name == "__Host-pa_session" for cookie in api.cookies), "session_cookie_missing")
    api.call("GET", "/api/v1/auth/session")

    project_id = select_project(api)
    check_workspace(api, project_id)
    check_facts(api, project_id)
    print("MVP2 local API check passed", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Run a bounded live check against the local MVP2 API.")
    parser.add_argument(
        "--confirm-live-local-api",
        action="store_true",
        help="opt in to authenticated requests against https://127.0.0.1:8443",
    )
    arguments = parser.parse_args()
    if not arguments.confirm_live_local_api:
        parser.error("pass --confirm-live-local-api to enable local API requests")
    try:
        run_probe()
    except ApiStatusFailure as error:
        print("MVP2 local API check failed status={}".format(error.status), file=sys.stderr, flush=True)
        return 1
    except ProbeFailure as error:
        print("MVP2 local API check failed check={}".format(str(error)), file=sys.stderr, flush=True)
        return 1
    except Exception as error:
        print("MVP2 local API check failed error={}".format(type(error).__name__), file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
