// JSON-RPC errors, with the codes the protocol and SEP-3415 define, and the HTTP status that goes with each.

export const Code = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
    // Core protocol, 2026-07-28.
    HeaderMismatch: -32020,
    MissingRequiredClientCapability: -32021,
    UnsupportedProtocolVersion: -32022,
    // SEP-3415, Error Handling.
    NotFound: -32023,
    Forbidden: -32024,
    ResourceExhausted: -32025,
    Unsupported: -32026,
    CallbackEndpointError: -32027
} as const;

export class RpcError extends Error {
    code: number;
    data?: Record<string, unknown>;
    status: number;
    constructor(code: number, message: string, data?: Record<string, unknown>, status = 200) {
        super(message);
        this.code = code;
        this.data = data;
        this.status = status;
    }
}

export const invalidParams = (message: string, data?: Record<string, unknown>, status = 200) => new RpcError(Code.InvalidParams, message, data, status);
