import assert from 'node:assert/strict';
import test from 'node:test';
import { piContentSecurityPolicy, piDomainSources, reviewMessage } from '../policy.mjs';

const directives = csp => Object.fromEntries(csp.split('; ').map(rule => {
    const [name, ...values] = rule.split(' ');
    return [name, values];
}));

test('uses the stable CSP default and only expands the explicitly declared directive', () => {
    const base = directives(piContentSecurityPolicy({}));
    assert.deepEqual(base, {
        'default-src': ["'none'"], 'script-src': ["'self'", "'unsafe-inline'"], 'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'], 'media-src': ["'self'", 'data:'], 'connect-src': ["'none'"],
        'frame-src': ["'none'"], 'base-uri': ["'self'"], 'object-src': ["'none'"], 'form-action': ["'none'"],
    });
    const connection = 'https://api.example.org';
    assert.deepEqual(directives(piContentSecurityPolicy({connectDomains:[connection]})), {...base, 'connect-src':[connection]});
    assert.deepEqual(directives(piContentSecurityPolicy({frameDomains:[connection]})), {...base, 'frame-src':[connection]});
});

test('opening consent describes the data, server reads, and every effective external destination', () => {
    const csp = { resourceDomains: ['https://assets.example.org'], frameDomains:['https://frames.example.org'],
        connectDomains:['https://assets.example.org'], baseUriDomains:['https://base.example.org'] };
    const text = reviewMessage('clock', 'get_time', csp);
    assert.match(text, /original input and result of "get_time"/);
    assert.match(text, /list and read resources from "clock"/);
    assert.match(text, /"https:\/\/assets.example.org", "https:\/\/base.example.org", "https:\/\/frames.example.org"/);
    assert.match(reviewMessage('clock','get_time',{}), /External destinations: none/);
    assert.throws(() => reviewMessage('clock','get_time',{connectDomains:['x'.repeat(3200)]}), /complete access request/);
});

test('reviews only individual host sources and retains path restrictions', () => {
    const valid = ['https://*.example.org:8443/icons/', 'wss://updates.example.org', 'cdn.example.org'];
    assert.deepEqual(piDomainSources({resourceDomains:[...valid, 'https:', '*', 'a.example b.example', 'blob:'], frameDomains:'example.org'}),
        {resourceDomains: valid});
});
