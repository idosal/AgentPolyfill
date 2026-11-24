// The model of the skill gate (verification/model.ts), explored in full to its bound on every test
// run: the invariants hold for the mod as it is, fail for 0.3.0's rule and for a lossy read-back
// (the documented limit), and catch each protection taken out of the model one at a time.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { explore, exploreServers, MUTANTS, type Options } from '../verification/model.ts';

const base: Options = { dynamic: false, sticky: true, lossyReadback: false, versions: 3 };

describe('the model of the skill gate', () => {
    test('every invariant holds in every reachable state and step, for a skill with a manifest and a dynamic one', () => {
        for (const dynamic of [false, true]) {
            const r = explore({ ...base, dynamic });
            assert.equal(r.violation, undefined, JSON.stringify(r.violation));
            assert.ok(r.states > (dynamic ? 1_000 : 100_000), `${r.states} states`);
        }
        assert.equal(exploreServers().violation, undefined);
        assert.equal(exploreServers().combinations, 192);
    });

    test("0.3.0's rule, where the latest load of a skill decided, lets a command run beside unapproved text", () => {
        const r = explore({ ...base, sticky: false });
        assert.equal(r.violation?.invariant, 'Gate');
        assert.deepEqual(r.violation?.trace.slice(1), ['Unchecked:loaded', 'Check:person-yes', 'Run:loaded', 'Tool(act,allow):runs']);
    });

    test('a read-back that misses a load (the documented limit) opens the gate, as docs/verification.md says', () => {
        assert.equal(explore({ ...base, lossyReadback: true }).violation?.invariant, 'Gate');
    });

    test('each protection, taken out of the model, is caught by an invariant', () => {
        for (const mutant of MUTANTS) {
            const caught = [explore({ ...base, mutant }), explore({ ...base, dynamic: true, mutant })].some((r) => r.violation) || exploreServers(mutant).violation !== undefined;
            assert.ok(caught, `${mutant} is not caught`);
        }
    });
});
