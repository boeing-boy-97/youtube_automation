"""A real SMTP server that writes every delivered message to disk.

The one-time-code tests need to read the code that was actually mailed. Faking `EmailService` would
prove nothing about the part that breaks in production (SMTP options, MIME headers, the address the
relay accepts), so the suite runs a genuine SMTP listener on localhost and the API talks to it over
the wire with nodemailer. This module is the listener; nothing in `apps/` knows it exists.

Usage:  python tests/e2e/smtp_sink.py --port 1025 --maildir /tmp/clipforge-inbox
"""
from __future__ import annotations

import argparse
import asyncio
import pathlib
import re
import sys
from email import message_from_bytes, policy

try:
    from aiosmtpd.controller import Controller
except ModuleNotFoundError:  # pragma: no cover - developer environment without the extra
    sys.exit("aiosmtpd is required: .venv/bin/pip install aiosmtpd")


class Sink:
    def __init__(self, maildir: pathlib.Path) -> None:
        self.maildir = maildir
        self.maildir.mkdir(parents=True, exist_ok=True)
        self.counter = 0

    async def handle_DATA(self, server, session, envelope):  # noqa: N802 - aiosmtpd API
        self.counter += 1
        message = message_from_bytes(envelope.content, policy=policy.default)
        # One file per message, numbered so ordering is preserved for the reader.
        path = self.maildir / f"{self.counter:04d}.eml"
        path.write_bytes(envelope.content)
        body = message.get_body(preferencelist=("plain",))
        text = body.get_content() if body else ""
        code = re.search(r"\b(\d{6})\b", text)
        print(
            f"[sink] {path.name} from={envelope.mail_from} to={','.join(envelope.rcpt_tos)} "
            f"subject={message['subject']!r} code={code.group(1) if code else None}",
            flush=True,
        )
        return "250 Message accepted for delivery"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=1025)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--maildir", default="/tmp/clipforge-inbox")
    args = parser.parse_args()

    sink = Sink(pathlib.Path(args.maildir))
    controller = Controller(sink, hostname=args.host, port=args.port, ready_timeout=10)
    controller.start()
    print(f"[sink] listening on {args.host}:{args.port}, writing to {args.maildir}", flush=True)
    try:
        asyncio.get_event_loop().run_forever()
    except KeyboardInterrupt:
        pass
    finally:
        controller.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
