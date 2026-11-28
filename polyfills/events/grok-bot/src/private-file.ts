import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

// Check the opened descriptor, including on reruns of init. O_NONBLOCK also lets us reject special files immediately.
export function privateFile(path: string, { secret = false, checkOnly = false } = {}) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.mode & (secret ? 0o077 : 0o022) ||
            (process.getuid && stat.uid !== process.getuid())) {
            throw Error(secret ? 'Use an owner-only regular routine credential file (chmod 600).' :
                'Use a regular configuration file owned by this account with no group or other writes.');
        }
        if (stat.size > (secret ? 8192 : 1024 * 1024)) throw Error('Configuration file exceeds its size limit.');
        return checkOnly ? '' : readFileSync(fd, 'utf8');
    } finally {
        closeSync(fd);
    }
}
