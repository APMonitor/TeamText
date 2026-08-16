import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

import phonenumbers

DRY_RUN = os.environ.get("SMS_DRY_RUN", "").strip().lower() in {"1", "true", "yes"}

if not DRY_RUN:
    import pyautogui as gui
    import pyperclip

    gui.FAILSAFE = True
else:
    gui = None
    pyperclip = None

MIN_MSG_CHARS = 5
DEFAULT_PAUSE_OPEN = 2.0
DEFAULT_PAUSE_BETWEEN = 7.0
DEFAULT_PAUSE_AFTER_SEND = 1.25
READY_MARKER = "__TEAMTEXT_SEND_READY__"
PROGRESS_MARKER = "__TEAMTEXT_SEND_PROGRESS__"
STATE_MARKER = "__TEAMTEXT_SEND_STATE__"

cancel_requested = False
pause_requested = False
control_generation = 0
acknowledged_control_generation = 0


def request_cancel(_signum, _frame) -> None:
    global cancel_requested, pause_requested, control_generation
    cancel_requested = True
    pause_requested = False
    control_generation += 1


def request_pause(_signum, _frame) -> None:
    global pause_requested, control_generation
    if cancel_requested:
        return
    pause_requested = True
    control_generation += 1


def request_resume(_signum, _frame) -> None:
    global pause_requested, control_generation
    if cancel_requested:
        return
    pause_requested = False
    control_generation += 1


signal.signal(signal.SIGTERM, request_cancel)
signal.signal(signal.SIGINT, request_cancel)
if hasattr(signal, "SIGUSR1"):
    signal.signal(signal.SIGUSR1, request_pause)
if hasattr(signal, "SIGUSR2"):
    signal.signal(signal.SIGUSR2, request_resume)


def load_payload() -> dict:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as exc:
        raise SystemExit("Expected one JSON payload on stdin.") from exc
    if not isinstance(payload, dict):
        raise SystemExit("Expected the JSON payload to be an object.")
    return payload


def e164(raw: str, region: str = "US") -> str | None:
    value = str(raw or "").strip()
    if not value:
        return None
    try:
        parsed = phonenumbers.parse(value, None if value.startswith("+") else region)
        if phonenumbers.is_valid_number(parsed):
            return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
    except Exception:
        return None
    return None


def frontmost_app_name() -> str:
    try:
        result = subprocess.check_output(
            [
                "osascript",
                "-e",
                'tell application "System Events" to name of first process whose frontmost is true',
            ],
            text=True,
        )
        return result.strip()
    except Exception:
        return ""


def open_compose_to(number_e164: str) -> None:
    subprocess.run(["osascript", "-e", 'tell application "Messages" to activate'], check=False)
    subprocess.run(["open", f"sms:{number_e164}"], check=True)


def type_and_send(body: str) -> bool:
    prior_clipboard = pyperclip.paste()
    clipboard_restored = True
    try:
        pyperclip.copy(body)
        gui.keyDown("command")
        try:
            gui.press("v")
        finally:
            gui.keyUp("command")
        time.sleep(0.05)
        gui.press("return")
    finally:
        try:
            pyperclip.copy(prior_clipboard)
        except Exception:
            clipboard_restored = False
            try:
                pyperclip.copy("")
            except Exception:
                pass
    return clipboard_restored


def emit_protocol(marker: str, payload: dict) -> None:
    print(f"{marker}{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}", file=sys.stderr, flush=True)


def acknowledge_control_state() -> None:
    global acknowledged_control_generation
    while acknowledged_control_generation != control_generation:
        generation = control_generation
        if cancel_requested:
            status = "cancelling"
        elif pause_requested:
            status = "paused"
        else:
            status = "running"
        acknowledged_control_generation = generation
        emit_protocol(STATE_MARKER, {"status": status})


def record_result(results: list[dict], result: dict) -> None:
    result.setdefault("sent_at", timestamp())
    results.append(result)
    progress = {
        "target_id": result.get("target_id"),
        "recipient_label": str(result.get("recipient_label", "")).strip(),
        "status": str(result.get("status", "failed")).strip().lower() or "failed",
        "sent_at": str(result.get("sent_at", "")).strip(),
    }
    error = str(result.get("error", "")).strip()
    if error:
        progress["error"] = error
    emit_protocol(PROGRESS_MARKER, progress)


def wait_until_running(step: float = 0.1) -> bool:
    while True:
        acknowledge_control_state()
        if cancel_requested:
            return False
        if not pause_requested:
            return True
        time.sleep(step)


def cancellable_sleep(seconds: float, step: float = 0.1) -> bool:
    remaining = max(seconds, 0.0)
    while remaining > 0:
        if not wait_until_running(step):
            return False
        sleep_for = min(step, remaining)
        started_at = time.monotonic()
        time.sleep(sleep_for)
        if not pause_requested:
            remaining -= time.monotonic() - started_at
    return not cancel_requested


def wait_for_messages_frontmost(timeout_seconds: float = 6.0) -> bool:
    remaining = max(timeout_seconds, 0.0)
    while remaining > 0:
        if not wait_until_running():
            return False
        if frontmost_app_name() == "Messages":
            return True
        started_at = time.monotonic()
        time.sleep(min(0.1, remaining))
        if not pause_requested:
            remaining -= time.monotonic() - started_at
    return False


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def result_for(message: dict) -> dict:
    return {
        "target_id": message.get("target_id"),
        "recipient_label": str(message.get("recipient_label", "")).strip(),
        "status": "failed",
    }


def payload_delay(payload: dict, key: str, fallback: float) -> float:
    try:
        value = float(payload.get(key, fallback))
    except (TypeError, ValueError):
        return fallback
    return max(value, 0.0)


def main() -> None:
    payload = load_payload()
    messages = payload.get("messages", [])
    if not isinstance(messages, list):
        raise SystemExit("Expected messages to be an array.")

    pause_open = payload_delay(payload, "pauseOpen", DEFAULT_PAUSE_OPEN)
    pause_between = payload_delay(payload, "pauseBetween", DEFAULT_PAUSE_BETWEEN)
    pause_after_send = payload_delay(payload, "pauseAfterSend", DEFAULT_PAUSE_AFTER_SEND)
    results = []
    completed_indexes = set()

    def finish_result(index: int, result: dict) -> None:
        completed_indexes.add(index)
        record_result(results, result)

    print(READY_MARKER, file=sys.stderr, flush=True)
    can_send = cancellable_sleep(0.1)

    if can_send and not DRY_RUN:
        subprocess.run(["open", "-a", "Messages"], check=False)
        can_send = cancellable_sleep(1.0)

    for index, message in enumerate(messages if can_send else []):
        if not isinstance(message, dict):
            continue

        result = result_for(message)
        if not wait_until_running():
            result["status"] = "cancelled"
            result["error"] = "Send stopped before this text began."
            result["sent_at"] = timestamp()
            finish_result(index, result)
            break

        body = str(message.get("body", "")).replace("\r\n", "\n").strip()
        number = e164(message.get("address", ""))

        if len(body) < MIN_MSG_CHARS:
            result["error"] = f"Message too short ({len(body)} chars)."
            finish_result(index, result)
            continue

        if not number:
            result["error"] = "Invalid or missing phone number."
            finish_result(index, result)
            continue

        try:
            if not DRY_RUN:
                open_compose_to(number)
                if not wait_for_messages_frontmost():
                    result["status"] = "cancelled" if cancel_requested else "failed"
                    result["error"] = (
                        "Send stopped before Messages was ready."
                        if cancel_requested
                        else "Messages did not become active in time."
                    )
                    result["sent_at"] = timestamp()
                    finish_result(index, result)
                    if cancel_requested:
                        break
                    continue

            if not cancellable_sleep(pause_open):
                result["status"] = "cancelled"
                result["error"] = "Send stopped before this text was entered."
                result["sent_at"] = timestamp()
                finish_result(index, result)
                break

            if not wait_until_running():
                result["status"] = "cancelled"
                result["error"] = "Send stopped before this text was entered."
                result["sent_at"] = timestamp()
                finish_result(index, result)
                break

            if not DRY_RUN:
                if frontmost_app_name() != "Messages":
                    result["error"] = "Messages lost focus before this text could be entered. Nothing was pasted or sent."
                    result["sent_at"] = timestamp()
                    finish_result(index, result)
                    continue
                # Treat paste-and-send as one atomic action. Pause or stop requests
                # received here take effect immediately after this text finishes.
                clipboard_restored = type_and_send(body)
                if not clipboard_restored:
                    result["error"] = "Text was submitted, but the prior clipboard text could not be restored."

            result["status"] = "simulated" if DRY_RUN else "submitted"
            result["sent_at"] = timestamp()
            finish_result(index, result)

            if cancel_requested or not cancellable_sleep(pause_after_send):
                break
            if index < len(messages) - 1 and not cancellable_sleep(pause_between):
                break
        except Exception:
            result["error"] = "Unable to control Messages. Check Accessibility permissions and try again."
            result["sent_at"] = timestamp()
            finish_result(index, result)

    if cancel_requested:
        for index, message in enumerate(messages):
            if index in completed_indexes or not isinstance(message, dict):
                continue
            result = result_for(message)
            result["status"] = "cancelled"
            result["error"] = "Send stopped before this text began."
            result["sent_at"] = timestamp()
            finish_result(index, result)

    print(json.dumps({"results": results, "cancelled": cancel_requested, "dryRun": DRY_RUN}), flush=True)


if __name__ == "__main__":
    main()
