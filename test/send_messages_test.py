import importlib.util
import io
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock


os.environ["SMS_DRY_RUN"] = "1"
SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "server" / "scripts" / "send_messages.py"
SPEC = importlib.util.spec_from_file_location("teamtext_sender", SCRIPT_PATH)
sender = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sender)


class FakeProcess:
    def __init__(self, output="submitted", returncode=0):
        self.returncode = returncode
        self.stdout = io.StringIO(f"{output}\n")

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = -15

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


class GroupSenderTests(unittest.TestCase):
    def setUp(self):
        sender.cancel_requested = False

    def test_recipient_groups_are_normalized_atomically(self):
        self.assertEqual(
            sender.normalized_recipients({"addresses": ["+1 202-555-0101", "+1 202-555-0104"]}),
            ["+12025550101", "+12025550104"],
        )
        self.assertIsNone(sender.normalized_recipients({"addresses": ["+12025550101", "(202) 555-0101"]}))
        self.assertIsNone(sender.normalized_recipients({"addresses": ["+12025550101; +12025550104"]}))

    def test_group_content_is_passed_outside_the_process_command(self):
        recipients = ["+12025550101", "+12025550104"]
        body = "Private group test body."
        with mock.patch.object(sender.subprocess, "Popen", return_value=FakeProcess()) as popen:
            status, error = sender.send_group_message(recipients, body)

        self.assertEqual((status, error), ("submitted", None))
        command = popen.call_args.args[0]
        serialized_command = " ".join(command)
        self.assertNotIn(body, serialized_command)
        self.assertFalse(any(number in serialized_command for number in recipients))
        environment = popen.call_args.kwargs["env"]
        self.assertEqual(environment["TEAMTEXT_GROUP_RECIPIENTS"], "\n".join(recipients))
        self.assertEqual(environment["TEAMTEXT_GROUP_BODY"], body)

    def test_group_applescript_compiles_against_messages(self):
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(
                ["osacompile", "-o", str(pathlib.Path(directory) / "group-send.scpt"), "-e", sender.GROUP_SEND_SCRIPT],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )

    def test_group_compose_failure_never_falls_back_to_individual_sends(self):
        with mock.patch.object(sender.subprocess, "Popen", return_value=FakeProcess("compose_failed")) as popen:
            status, error = sender.send_group_message(["+12025550101", "+12025550104"], "Group body.")

        self.assertEqual(status, "failed")
        self.assertIn("Nothing was sent", error)
        popen.assert_called_once()


if __name__ == "__main__":
    unittest.main()
