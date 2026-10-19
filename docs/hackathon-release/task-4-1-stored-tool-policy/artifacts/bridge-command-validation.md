# Bridge command validation

2026-10-19, developer bridge, Windows Python 3.13. No provider calls, application database access, ports, installs or deployment changes.

## Local checks

From `Personal-AI-Workspace`:

```
python -m unittest discover -s deploy/hermes-bridge/tests -p 'test_*.py'
Ran 48 tests
OK (skipped=3)
```

45 passed: 22 unchanged planning regression checks and 23 new policy control-flow checks. Three explicitly skipped tests require an actual Linux x86_64 kernel: network/fork/CPU/address-space restrictions; invalid UTF-8 output cap; real idle/wall timeouts and child reaping. Mocked parent-loop tests do not prove kernel enforcement.

`python -m py_compile` passed for all four touched Python production files and the new policy test. `git diff --check -- deploy/hermes-bridge` passed. Windows checks were rerun after fixes; earlier local attempts caught a Windows-only SIGHUP test harness issue and a SIGKILL mocking issue, both resolved. One invocation used an incorrect discovery working-directory prefix and was corrected; it provided no test evidence.

## Runtime boundary proof status

Read-only Docker inventory found existing `personal-ai-hermes@sha256:6c672fd4bdb49502b6407546c92fbb683dc1a08e65d5df31813a67488fd16a02`, daemon Linux/amd64. After the primary developer released PostgreSQL and the project-manager granted the isolated window, this exact command ran:

```powershell
docker run --rm --pull never --name pai-policy-command-kernel-test --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 16 --memory 384m --cpus 1 --user 65534:65534 --tmpfs /tmp:rw,nosuid,nodev,size=16m --mount 'type=bind,source=$WORKSPACE_ROOT\deploy\hermes-bridge,target=/bridge,readonly' --workdir /bridge --entrypoint /opt/hermes/.venv/bin/python personal-ai-hermes@sha256:6c672fd4bdb49502b6407546c92fbb683dc1a08e65d5df31813a67488fd16a02 -B -m unittest discover -s tests -p 'test_*.py'
```

Exit 0:

```
Ran 48 tests in 15.765s
OK
```

All 48 passed with zero skips. Actual Linux child assertions verified socket creation and fork receive `PermissionError`, hard `RLIMIT_CPU=(5,5)` and `RLIMIT_AS=(134217728,134217728)`, rejected 200 MiB allocation, bounded invalid UTF-8 output, actual idle timeout below 10 seconds and wall timeout at 10–12 seconds, and reaped negative exit status after termination. Outer `--network none` does not itself prohibit socket creation, so the socket assertion specifically exercises the internal seccomp restriction. Mocked tests separately inspect process-group targeting, minimal environment and descriptor closure.

Independent postflight `docker container ls -a --filter 'name=^/pai-policy-command-kernel-test$' --format '{{.Names}} {{.Status}}'` returned no rows: the container was removed. Image inspection returned the same exact `sha256:6c672fd4bdb49502b6407546c92fbb683dc1a08e65d5df31813a67488fd16a02`. No image pull/build/install, source write, environment/secret/socket/port mount, provider call or database operation occurred. Test window released to project-manager and primary.

Global bridge capability remains `supported:false`: these are actual local-executor Linux kernel checks in the existing image, not a deployed OpenShell/provider test or a receipt proving all limits at the pinned OpenShell deployment. Provider admission readiness remains independently closed.

## Reference behavior checked

- [Linux kernel seccomp filter documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html): architecture guard, no-new-privileges, inherited syscall filter and errno denial.
- [Python subprocess documentation](https://docs.python.org/3/library/subprocess.html): shell-free argv, descriptor handling and avoiding `preexec_fn` in a threaded process. A separate isolated helper installs restrictions before `execve`.

Context7 and Chrome DevTools are not available/applicable to this standard-library-only Python slice; no browser changes were made.
