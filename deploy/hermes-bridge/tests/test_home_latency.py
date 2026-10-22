"""Home warm-slot isolation and bounded notification waits; no provider or shell calls."""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import planning_lifecycle as planning

TURN = 'c38135b6-f877-4e9c-899a-4c0e53864854'
OTHER = 'b5f9b759-f2b9-4949-a98d-20697e01acb2'
CAP = 'a' * 43
ROUTE = {'providerProfile': 'nebius-token-factory', 'model': 'nvidia/nemotron-3-super-120b-a12b', 'endpoint': 'https://api.tokenfactory.nebius.com/v1'}
PAYLOAD = {**ROUTE, 'maxOutputTokens': 512, 'requiredProviderReceiptVersion': 1}

class FakeThread:
    def __init__(self, target, daemon=False):
        self.target = target
    def start(self):
        pass

class HomeLatencyTests(unittest.TestCase):
    def setUp(self):
        server.RUNS.clear()
        server.PLANNING_RUNS.clear()
        server.PLANNING_ALIASES.clear()
        server.WARM_PLANNING_ID = None
    def tearDown(self):
        self.setUp()
    def body(self, operation, identity=TURN, payload=None, capability=CAP):
        return {'operation': operation, 'runId': identity, 'capability': capability, 'payload': payload if payload is not None else {**PAYLOAD, 'prompt': 'synthetic'}}
    def test_empty_warm_runtime_is_assigned_once_and_deletes_under_original_owned_identity(self):
        with patch.object(server, 'profile', return_value=ROUTE), patch.object(server, 'assert_route'), patch.object(server.threading, 'Thread', FakeThread):
            server.prepare_home_runtime()
            warm_id = server.WARM_PLANNING_ID
            warm = server.PLANNING_RUNS[warm_id]
            self.assertNotIn('prompt', warm.payload)
            self.assertTrue(warm.awaiting_prompt)
            self.assertFalse(warm.prompt_ready.is_set())
            self.assertFalse(server.home_warm_ready())
            warm.prepared.set()
            self.assertTrue(server.home_warm_ready())
            warm.local = Mock(exists=Mock(return_value=True))
            warm._write_ledger = Mock()
            self.assertEqual(server.dispatch(self.body('planning-create')), {'status': 'preparing'})
            self.assertFalse(warm.awaiting_prompt)
            self.assertFalse(server.home_warm_ready())
            self.assertEqual(warm.assigned_identity, TURN)
            self.assertTrue(warm.prompt_ready.is_set())
            self.assertEqual(server.PLANNING_ALIASES[TURN], warm_id)
            self.assertEqual(warm.capability, CAP)
            self.assertEqual(server.dispatch(self.body('planning-create')), {'status': 'preparing'})
            warm._write_ledger.assert_called_once()
            with self.assertRaises(server.BridgeError):
                server.dispatch(self.body('planning-poll', payload={'cursor': 0}, capability='b' * 43))
            server.dispatch(self.body('planning-create', identity=OTHER))
            self.assertIsNot(server.PLANNING_RUNS[OTHER], warm)
            warm.status = 'completed'
            warm.delete = Mock()
            server.dispatch(self.body('planning-delete', payload={}))
            self.assertNotIn(warm_id, server.PLANNING_RUNS)
            self.assertNotIn(TURN, server.PLANNING_ALIASES)
    def test_partly_prepared_slot_is_claimed_without_creating_a_premature_ledger(self):
        with patch.object(server, 'profile', return_value=ROUTE), patch.object(server, 'assert_route'), patch.object(server.threading, 'Thread', FakeThread):
            server.prepare_home_runtime()
            warm = server.PLANNING_RUNS[server.WARM_PLANNING_ID]
            warm.local = Mock(exists=Mock(return_value=False))
            warm._write_ledger = Mock()
            self.assertFalse(warm.prepared.is_set())
            server.dispatch(self.body('planning-create'))
            self.assertEqual(server.PLANNING_ALIASES[TURN], warm.identity)
            self.assertEqual(warm.assigned_identity, TURN)
            self.assertFalse(warm.awaiting_prompt)
            warm._write_ledger.assert_not_called()

    def test_differently_bounded_warm_slot_uses_a_fresh_run(self):
        with patch.object(server, 'profile', return_value=ROUTE), patch.object(server, 'assert_route'), patch.object(server.threading, 'Thread', FakeThread):
            server.prepare_home_runtime()
            warm = server.PLANNING_RUNS[server.WARM_PLANNING_ID]
            server.dispatch(self.body('planning-create', payload={**PAYLOAD, 'maxOutputTokens': 64, 'prompt': 'synthetic'}))
            self.assertIsNot(server.PLANNING_RUNS[TURN], warm)
            self.assertTrue(warm.awaiting_prompt)
            self.assertNotIn('prompt', warm.payload)

    def test_warming_respects_shared_capacity_and_does_not_create_a_second_idle_slot(self):
        with patch.object(server, 'profile', return_value=ROUTE), patch.object(server.threading, 'Thread', FakeThread):
            server.prepare_home_runtime()
            server.prepare_home_runtime()
            self.assertEqual(len(server.PLANNING_RUNS), 1)
            server.WARM_PLANNING_ID = None
            server.RUNS.update({str(i): object() for i in range(3)})
            server.prepare_home_runtime()
            self.assertEqual(len(server.PLANNING_RUNS), 1)
    def test_prepared_process_never_receives_a_prompt_until_assignment(self):
        run = planning.PlanningRun(TURN, CAP, PAYLOAD, prepare_only=True)
        run._create = Mock()
        run._create_empty_workdir = Mock()
        fake_acp = Mock()
        with patch.object(planning, 'AcpSession', return_value=fake_acp):
            worker = threading.Thread(target=run.work, daemon=True)
            worker.start()
            self.assertTrue(run.prepared.wait(1))
            fake_acp.prompt.assert_not_called()
            self.assertEqual(run.status, 'preparing')
            run.payload = {**PAYLOAD, 'prompt': 'synthetic'}
            run.awaiting_prompt = False
            run.prompt_ready.set()
            worker.join(1)
            self.assertFalse(worker.is_alive())
            fake_acp.prompt.assert_called_once_with('synthetic', timeout=planning.INFERENCE_TIMEOUT_SECONDS)
            self.assertEqual(run.status, 'completed')
    def test_poll_wakes_on_progress_instead_of_waiting_for_a_client_timer(self):
        run = planning.PlanningRun(TURN, CAP, PAYLOAD)
        waiting = threading.Event()
        original = run.changed.wait
        result = []
        def wait(timeout):
            waiting.set()
            return original(timeout)
        with patch.object(run.changed, 'wait', side_effect=wait):
            worker = threading.Thread(target=lambda: result.append(run.poll(0, 1000)))
            worker.start()
            self.assertTrue(waiting.wait(1))
            run.push({'type': 'started'})
            worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result[0]['events'][0]['sequence'], 1)
        for invalid in (True, -1, 1001, 1.5):
            with self.assertRaises(planning.BridgeError):
                run.poll(0, invalid)
    def test_restart_preserves_assigned_alias_as_unknown_and_discards_only_unused_warm_slot(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            name = planning.planning_sandbox_name(TURN)
            directory = state / 'planning-runs' / name
            directory.mkdir(parents=True)
            ledger = directory / 'ledger.json'
            value = {'runId': TURN, 'capability': CAP, 'sandboxId': 'sandbox-1', 'sandboxName': name, 'unclaimed': False, 'assignedRunId': OTHER}
            ledger.write_text(json.dumps(value), encoding='utf-8')
            with patch.object(server, 'STATE', state), patch.object(planning, 'STATE', state):
                server.recover_runs()
                self.assertEqual(server.PLANNING_ALIASES[OTHER], TURN)
                self.assertEqual(server.PLANNING_RUNS[TURN].status, 'unknown')
                server.PLANNING_RUNS.clear()
                server.PLANNING_ALIASES.clear()
                value.pop('assignedRunId')
                value.update(unclaimed=True)
                ledger.write_text(json.dumps(value), encoding='utf-8')
                with patch.object(planning.PlanningRun, 'delete') as delete:
                    server.recover_runs()
                delete.assert_called_once()
                self.assertEqual(server.PLANNING_RUNS, {})

if __name__ == '__main__':
    unittest.main()
