import { Rpc } from '@opencode/plugin/rpc';

const text = { type: 'string' } as const;
const request = { sessionID: text, ticket: text };
export const Dialog = Rpc.define({
    id: 'mcp-tasks-dialog',
    methods: {
        question: {
            input: { type: 'object', properties: request, required: ['sessionID', 'ticket'], additionalProperties: false },
            output: { type: 'object', properties: { title: text, message: text, proof: text, input: { type: 'boolean' } }, additionalProperties: false },
            errors: {}
        },
        reply: {
            input: { type: 'object', properties: { ...request, proof: text, action: { type: 'string', enum: ['accept', 'decline', 'cancel'] }, value: text }, required: ['sessionID', 'ticket', 'proof', 'action'], additionalProperties: false },
            output: { type: 'object', additionalProperties: false },
            errors: {}
        }
    },
    events: {
        question: { schema: { type: 'object', properties: request, required: ['sessionID', 'ticket'], additionalProperties: false } }
    }
});
