/** The Mac owner can approve top-level remote reads. Nested remote entries stay closed. */
export function readDecision(options: { remote: boolean; nested: boolean; ownerDialog: boolean; askBeforeReading?: boolean }): 'read' | 'ask' | 'decline' {
    if (options.remote && options.nested) return 'decline';
    if (options.ownerDialog) return 'ask';
    if (!options.nested && options.askBeforeReading === false) return 'read';
    return options.remote ? 'decline' : 'ask';
}
