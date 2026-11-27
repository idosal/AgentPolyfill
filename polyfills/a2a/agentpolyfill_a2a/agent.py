"""The remote side: A2A 1.0 JSON-RPC through the official Python SDK."""

import ipaddress
import json
import os
import unicodedata
import stat
import subprocess
from urllib.parse import urlsplit

import httpx
from a2a.client.card_resolver import A2ACardResolver
from a2a.client.client import ClientCallContext
from a2a.client.transports.jsonrpc import JsonRpcTransport
from a2a.types import a2a_pb2 as a2a

STRUCTURED = "https://github.com/a2aproject/experimental-ext-structured-input/tree/main/v1"


class AdapterError(Exception):
    def __init__(self, message, code=-32602, data=None):
        super().__init__(message)
        self.code, self.data = code, data


def origin(url):
    if not isinstance(url, str) or any(c.isspace() or unicodedata.category(c).startswith("C") for c in url) or "\\" in url:
        raise AdapterError("The agent URL contains whitespace or an invalid character.")
    p = urlsplit(url)
    if not p.hostname or p.username is not None or p.password is not None or p.query or p.fragment:
        raise AdapterError("Use an agent URL without embedded credentials, query, or fragment.")
    try:
        local = ipaddress.ip_address(p.hostname).is_loopback
    except ValueError:
        local = p.hostname == "localhost"
    if p.scheme != "https" and not (local and p.scheme == "http"):
        raise AdapterError("The configured agent needs HTTPS or a loopback HTTP URL.")
    return p.scheme, p.hostname, p.port if p.port is not None else (443 if p.scheme == "https" else 80)


MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class BoundedStream(httpx.AsyncByteStream):
    def __init__(self, inner):
        self.inner = inner

    async def __aiter__(self):
        remaining = MAX_RESPONSE_BYTES
        async for chunk in self.inner:
            remaining -= len(chunk)
            if remaining < 0:
                raise AdapterError("The agent response exceeds the 2 MiB limit.")
            yield chunk

    async def aclose(self):
        await self.inner.aclose()


async def limit_response(response):
    # Both card discovery and SDK requests use this hook before HTTPX reads the body.
    if response.headers.get("content-encoding", "identity").lower() != "identity":
        raise AdapterError("The agent returned a compressed response after identity encoding was requested.")
    size = response.headers.get("content-length")
    if size and (not size.isdecimal() or int(size) > MAX_RESPONSE_BYTES):
        raise AdapterError("The agent response exceeds the 2 MiB limit or has an invalid length.")
    response.stream = BoundedStream(response.stream)


class Agent:
    def __init__(self, http: httpx.AsyncClient, url: str, serve_credentials=None, bearer_env=None, bearer_file=None):
        self.origin = origin(url)
        self.url = url.rstrip("/")
        self.http = http
        self.serve_credentials = serve_credentials
        self.bearer_env = bearer_env
        self.bearer_file = bearer_file
        self.transport = None
        self.tenant = ""
        self.structured = False

    def headers(self):
        headers = {}
        if self.bearer_env:
            token = os.environ.get(self.bearer_env)
            if not token:
                raise AdapterError("The configured bearer-token environment variable is empty.")
            headers["Authorization"] = "Bearer " + token
        if self.bearer_file:
            # A replaced credential path must not block this stdio process on a FIFO.
            def open_credential(path, flags):
                return os.open(path, flags | os.O_NONBLOCK)

            with open(self.bearer_file, encoding="utf-8", opener=open_credential) as token_file:
                mode = os.fstat(token_file.fileno())
                if not stat.S_ISREG(mode.st_mode) or mode.st_mode & 0o077 or mode.st_uid != os.getuid():
                    raise AdapterError("Use an owner-only bearer token file.")
                raw = token_file.read(8195)
                if len(raw) > 8194:
                    raise AdapterError("Invalid bearer token file.")
                token = raw.rstrip("\r\n")
                if not token or len(token) > 8192 or not token.isascii() or any(not 33 <= ord(c) <= 126 for c in token):
                    raise AdapterError("Invalid bearer token file.")
            headers["Authorization"] = "Bearer " + token
        if self.serve_credentials:
            proc = subprocess.run(
                [self.serve_credentials, "credential", "get"],
                input=json.dumps({"uri": self.url}),
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if proc.returncode:
                raise AdapterError("A2A Serve could not read credentials for the configured agent.")
            headers = {k: ", ".join(v) for k, v in json.loads(proc.stdout).get("headers", {}).items()}
            if not headers:
                raise AdapterError("A2A Serve has no pairing for the configured agent.")
        return {**headers, "A2A-Version": "1.0"}

    async def connect(self):
        if self.transport:
            return
        card = await A2ACardResolver(self.http, self.url).get_agent_card(
            http_kwargs={"headers": self.headers()}
        )
        if any(e.required and e.uri != STRUCTURED for e in card.capabilities.extensions):
            raise AdapterError("The agent requires an unsupported A2A extension.")
        for interface in card.supported_interfaces:
            if (
                interface.protocol_binding == "JSONRPC"
                and interface.protocol_version == "1.0"
                and origin(interface.url) == self.origin
            ):
                self.transport = JsonRpcTransport(self.http, card, interface.url, is_shared_httpx=True)
                self.tenant = interface.tenant
                self.structured = any(e.uri == STRUCTURED for e in card.capabilities.extensions)
                return
        raise AdapterError("The card offers no A2A 1.0 JSON-RPC interface at the configured origin.")

    def context(self):
        headers = self.headers()
        if self.structured:
            headers["A2A-Extensions"] = STRUCTURED
        return ClientCallContext(service_parameters=headers)

    async def send(self, message):
        await self.connect()
        request = a2a.SendMessageRequest(
            message=message,
            tenant=self.tenant,
            configuration=a2a.SendMessageConfiguration(return_immediately=True),
        )
        return await self.transport.send_message(request, context=self.context())

    async def get(self, task_id):
        await self.connect()
        return await self.transport.get_task(
            a2a.GetTaskRequest(id=task_id, tenant=self.tenant, history_length=0), context=self.context()
        )

    async def cancel(self, task_id):
        await self.connect()
        return await self.transport.cancel_task(
            a2a.CancelTaskRequest(id=task_id, tenant=self.tenant), context=self.context()
        )
